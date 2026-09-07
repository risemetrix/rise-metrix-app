/* Rise Metrix — cloud sync adapter (Supabase). Loaded only when window.RMX_CONFIG is set.
   Design: the COACH device is the writer. Coach pushes state changes; athlete devices are
   readers + interact via edge functions (join/trivia/ballot). Offline-first: everything
   queues in localStorage and flushes when online. Solo mode (no config) = this file inert. */
"use strict";
(function(){
  const CFG = window.RMX_CONFIG;                 // {url, anonKey}
  if(!CFG || !CFG.url || !CFG.anonKey) { window.RMXCloud = null; return; }

  const SLOT = window.RMX_SLOT || "a";           // multi-team: keys are per-slot
  const QKEY = "risemetrix.queue." + SLOT;
  const MKEY = "risemetrix.cloudmeta." + SLOT;   // {teamId, pushedEventIds:[], role:'coach'|'athlete', claim, playerMap:{localId:uuid}}
  let sb = null, meta = load(MKEY, {pushedEventIds:[], playerMap:{}});
  const save_ = (k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
  function load(k,d){try{return JSON.parse(localStorage.getItem(k))||d}catch(e){return d}}
  const q = ()=>load(QKEY,[]);
  const enq = (op)=>{const list=q();list.push(op);save_(QKEY,list);flushSoon()};

  let flushTimer=null;
  function flushSoon(){clearTimeout(flushTimer);flushTimer=setTimeout(flush,800)}

  async function ensureClient(){
    if(sb) return sb;
    if(!window.supabase){ await import(CFG.sdkUrl||"https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm").then(m=>{window.supabase=m}); }
    sb = window.supabase.createClient(CFG.url, CFG.anonKey);
    return sb;
  }

  /* ---------- coach auth ---------- */
  // Sends a magic link. Clicking the link on THIS device signs the coach in
  // (supabase-js picks the session out of the redirect URL automatically).
  async function signInEmail(email){
    await ensureClient();
    const { error } = await sb.auth.signInWithOtp({ email, options:{ emailRedirectTo: location.origin } });
    if(error) throw error;
    return true;
  }
  async function verifyCode(email, token){
    await ensureClient();
    const { data, error } = await sb.auth.verifyOtp({ email, token, type:"email" });
    if(error) throw error;
    return data.session;
  }
  async function session(){ await ensureClient(); return (await sb.auth.getSession()).data.session; }

  /* ---------- coach: create/link team ---------- */
  async function createTeamCloud(S){
    await ensureClient();
    const u = (await sb.auth.getUser()).data.user;
    const { data, error } = await sb.from("teams").insert({
      name:S.team.name, season:S.team.season, join_code:S.team.code, cfg:S.team.cfg, owner:u.id
    }).select("id").single();
    if(error) throw error;
    meta.teamId = data.id; meta.role="coach"; save_(MKEY,meta);
    // push roster
    for(const p of S.players) await pushPlayer(p);
    return data.id;
  }
  async function pushPlayer(p){
    if(!meta.teamId) return;
    const row = { team_id:meta.teamId, name:p.n, initials:p.i, pos:p.pos, grade:p.grade,
      height_in:p.h, weight_lb:p.w, fact:p.fact||null, mx:p.mx||{}, sq:p.sq||null };
    const cloudId = meta.playerMap[p.id];
    enq(cloudId ? {t:"player_update", id:cloudId, row} : {t:"player_insert", localId:p.id, row});
  }
  function pushEvent(S, e){
    if(!meta.teamId || meta.pushedEventIds.includes(e.id)) return;
    enq({t:"event", localId:e.id, row:{
      team_id:meta.teamId, act:e.act, pts:e.pts, cat:e.cat, note:e.note,
      event_date:e.date, season:S.team.season,
      local_player_ids:e.pids }});
  }
  function pushFeed(f){ if(meta.teamId) enq({t:"feed", row:{team_id:meta.teamId, who:f.who, amt:f.amt, d:f.d, tag:f.tag, hot:!!f.hot}}); }
  function pushTeam(S){ if(!meta.teamId) return;
    const list=q().filter(op=>op.t!=="team_update");           // collapse to one pending update
    list.push({t:"team_update", row:{name:S.team.name, season:S.team.season, cfg:S.team.cfg}});
    save_(QKEY,list); flushSoon(); }
  function deletePlayer(localId){ const cid=meta.playerMap[localId];
    if(meta.teamId&&cid){ enq({t:"player_delete", id:cid}); delete meta.playerMap[localId]; save_(MKEY,meta); } }

  /* ---------- the queue flush ---------- */
  let flushing=false;
  async function flush(){
    if(flushing || !navigator.onLine) return; flushing=true;
    try{
      await ensureClient();
      let list=q();
      while(list.length){
        const op=list[0];
        if(op.t==="player_insert"){
          const {data,error}=await sb.from("players").insert(op.row).select("id").single();
          if(error) break;
          meta.playerMap[op.localId]=data.id; save_(MKEY,meta);
        } else if(op.t==="player_update"){
          const {error}=await sb.from("players").update(op.row).eq("id",op.id);
          if(error) break;
        } else if(op.t==="event"){
          const uuids=(op.row.local_player_ids||[]).map(l=>meta.playerMap[l]).filter(Boolean);
          if(uuids.length!==op.row.local_player_ids.length){ break; } // wait until players sync
          const row={...op.row, player_ids:uuids}; delete row.local_player_ids;
          const {error}=await sb.from("point_events").insert(row);
          if(error) break;
          meta.pushedEventIds.push(op.localId);
          if(meta.pushedEventIds.length>2000) meta.pushedEventIds=meta.pushedEventIds.slice(-1500);
          save_(MKEY,meta);
        } else if(op.t==="feed"){
          const {error}=await sb.from("feed").insert(op.row);
          if(error) break;
        } else if(op.t==="team_update"){
          const {error}=await sb.from("teams").update(op.row).eq("id",meta.teamId);
          if(error) break;
        } else if(op.t==="player_delete"){
          const {error}=await sb.from("players").delete().eq("id",op.id);
          if(error) break;
        }
        list.shift(); save_(QKEY,list);
      }
    } finally { flushing=false; }
  }
  window.addEventListener("online", flushSoon);
  setInterval(flushSoon, 25000);

  /* ---------- athlete mode ---------- */
  async function joinTeam(code, name){
    const r = await fetch(CFG.url+"/functions/v1/join_team", {
      method:"POST", headers:{ "content-type":"application/json", apikey:CFG.anonKey },
      body: JSON.stringify({ code, name }) });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error||"join failed");
    meta.role="athlete"; meta.claim=j.claim; meta.teamId=j.team.id; save_(MKEY,meta);
    return j;
  }
  async function athlete(action, extra){
    const r = await fetch(CFG.url+"/functions/v1/athlete_api", {
      method:"POST", headers:{ "content-type":"application/json", apikey:CFG.anonKey },
      body: JSON.stringify({ action, claim: meta.claim, ...extra }) });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error||"request failed");
    return j;
  }

  /* ---------- coach: pull (second device / restore) ---------- */
  async function myTeams(){
    await ensureClient();
    const { data, error } = await sb.from("teams").select("id,name,season,join_code,cfg").order("created_at",{ascending:false});
    if(error) throw error;
    return data||[];
  }
  async function pullTeam(teamId){
    await ensureClient();
    const [team, players, events, feed] = await Promise.all([
      sb.from("teams").select("id,name,season,join_code,cfg").eq("id",teamId).single(),
      sb.from("players").select("*").eq("team_id",teamId).order("created_at"),
      sb.from("point_events").select("*").eq("team_id",teamId).order("created_at"),
      sb.from("feed").select("*").eq("team_id",teamId).order("created_at",{ascending:false}).limit(120),
    ]);
    if(team.error) throw team.error;
    meta.teamId = teamId; meta.role = "coach"; save_(MKEY,meta);
    return { team:team.data, players:players.data||[], events:events.data||[], feed:feed.data||[] };
  }
  async function claimCodes(){
    await ensureClient();
    if(!meta.teamId) return [];
    const { data } = await sb.from("players").select("name,claim_code").eq("team_id",meta.teamId).order("name");
    return data||[];
  }
  async function signOut(){ await ensureClient(); await sb.auth.signOut(); }

  // Eagerly create the client so a magic-link redirect (#access_token=...) is
  // consumed into a stored session as soon as the page loads.
  if(/access_token|type=magiclink/.test(location.hash)) ensureClient().catch(()=>{});

  window.RMXCloud = {
    enabled:true, meta:()=>meta, saveMeta:()=>save_(MKEY,meta),
    signInEmail, verifyCode, session, signOut,
    createTeamCloud, pushPlayer, pushEvent, pushFeed, pushTeam, deletePlayer, flush,
    myTeams, pullTeam, claimCodes,
    joinTeam, athleteBoard:()=>athlete("board"),
    athleteTrivia:(answer_id)=>athlete("trivia",{answer_id}),
    athleteBallot:(vote_id,player_id)=>athlete("ballot",{vote_id,player_id}),
  };
})();
