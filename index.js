(() => {
  'use strict';
  let api, store, channels, selected, users, dispatcher, live = false, epoch = 0;
  let timer = null, busy = false, queue = [], status = '준비 중', cooldownUntil = 0;
  const cache = new Map(), pending = new Set(), redraws = new Map();
  const MAX_CACHE = 400, MAX_QUEUE = 60, MARK = '\u200b\u200c';
  const label = '\n🇰🇷 번역: ';
  const keyOf = (m) => `${m.channel_id}:${m.id}`;
  function remember(key, entry) {
    cache.delete(key); cache.set(key, entry);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  function allowed(ch) {
    if (!live || !api.storage.consent || !ch || !Array.isArray(api.storage.channelIds) || !api.storage.channelIds.includes(ch)) return false;
    try { const c = channels.getChannel(ch); return !!(c && (c.guild_id || c.guildId) && selected.getChannelId() === ch); } catch (_) { return false; }
  }
  function sourceText(s) {
    if (typeof s !== 'string' || !s.trim() || s.length > 1800 || /```|\|\|/.test(s)) return '';
    // Do not transmit URLs, Discord IDs/mentions, custom emoji, or inline code.
    const t = s.replace(/https?:\/\/[^\s<>]+|<[^>]+>|`[^`]*`/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || !/[A-Za-z\u00c0-\u02ff\u0370-\u052f\u0590-\u08ff\u0900-\u0fff\u1100-\u11ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(t)) return '';
    if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(t) && !/[A-Za-z\u00c0-\u02ff\u0370-\u052f\u0590-\u08ff\u0900-\u0fff\u3040-\u30ff\u3400-\u9fff]/.test(t)) return '';
    return t;
  }
  function errorLabel(e) {
    // Never display URLs, query text, or response bodies in diagnostics.
    const m = String(e?.message || '');
    if (/^HTTP \d{3}$/.test(m)) return m;
    if (m === 'Timeout') return '15초 시간 초과';
    if (m === 'Unexpected response') return '응답 형식 불일치';
    if (m === 'Invalid JSON') return 'JSON 해석 실패';
    if (/network|fetch|connect/i.test(m)) return '네트워크 요청 실패';
    if (/abort/i.test(m)) return '요청 취소';
    return '기타 오류 (' + (['TypeError','Error','ReferenceError','SyntaxError'].includes(e?.name) ? e.name : 'Unknown') + ')';
  }
  async function translate(t, engine = api.storage.engine || 'gtx') {
    const base = engine === 'web' ? 'https://translate.google.com' : 'https://translate.googleapis.com';
    const url = base + '/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=' + encodeURIComponent(t);
    // React Native versions vary in AbortController support; a deadline is always used.
    let timeout;
    try {
      return await Promise.race([(async () => {
        const res = await fetch(url, {credentials: 'omit'});
        if (!res.ok) throw Error('HTTP ' + res.status);
        let json; try { json = await res.json(); } catch (_) { throw Error('Invalid JSON'); }
        if (!Array.isArray(json?.[0])) throw Error('Unexpected response');
        if (json[2] === 'ko') return '';
        const result = json[0].map(x => typeof x?.[0] === 'string' ? x[0] : '').join('').trim();
        if (!result) throw Error('Unexpected response');
        return result === t ? '' : result;
      })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Timeout')), 15000); })]);
    } finally { clearTimeout(timeout); }
  }
  // A temporary local Flux update triggers native row regeneration. No Discord HTTP request.
  function restore(key) {
    const item = redraws.get(key); if (!item) return;
    clearTimeout(item.timer); redraws.delete(key);
    try {
      const m = store.getMessage(item.channel, item.id);
      if (m?.content === item.original + MARK) dispatcher.dispatch({type:'MESSAGE_UPDATE',message:{id:item.id,channel_id:item.channel,content:item.original},log_edit:false,otherPluginBypass:true,__distraAutoKo:true});
    } catch (_) {}
  }
  function refresh(item) {
    if (!allowed(item.channel)) return;
    const m = store.getMessage(item.channel, item.id);
    if (!m || m.content !== item.original || redraws.has(item.key)) return;
    const record = {...item, timer: null}; redraws.set(item.key, record);
    try {
      dispatcher.dispatch({type:'MESSAGE_UPDATE',message:{id:item.id,channel_id:item.channel,content:item.original+MARK},log_edit:false,otherPluginBypass:true,__distraAutoKo:true});
      record.timer = setTimeout(() => restore(item.key), 250);
    } catch (_) { redraws.delete(item.key); }
  }
  function schedule(delay = 350) {
    if (!live || busy || timer !== null || !queue.length) return;
    timer = setTimeout(() => { timer = null; void work(); }, Math.max(delay, cooldownUntil - Date.now()));
  }
  async function work() {
    if (!live || busy) return;
    const item = queue.shift(); if (!item) return;
    const token = epoch;
    if (!allowed(item.channel)) { pending.delete(item.pendingKey); schedule(); return; }
    busy = true;
    let delay = 500;
    try {
      const result = await translate(item.text);
      if (live && epoch === token && allowed(item.channel)) {
        remember(item.key, {original:item.original, translated:result});
        status = '번역 정상';
        if (result) refresh(item);
      }
    } catch (e) {
      if (live && epoch === token) {
        remember(item.key, {original:item.original, translated:'', retry:Date.now()+60000});
        status = '번역 요청 실패: ' + errorLabel(e) + ' (60초 후 재시도 가능)'; cooldownUntil = Date.now()+60000; delay = 60000;
      }
    } finally { pending.delete(item.pendingKey); busy = false; schedule(delay); }
  }
  function stripMark(nodes) {
    return nodes.map(n => n?.type === 'text' && typeof n.content === 'string' && n.content.includes(MARK) ? {...n,content:n.content.split(MARK).join('')} : Array.isArray(n?.content) ? {...n,content:stripMark(n.content)} : n);
  }
  function onRow(args, row) {
    try {
      const data = args[0], m = data?.message;
      if (data?.rowType !== 1 || !m?.id || !m.channel_id || !Array.isArray(row?.message?.content) || !allowed(m.channel_id)) return;
      if (![0,19].includes(m.type ?? 0) || !m.author?.id || m.author.id === users.getCurrentUser()?.id) return;
      const key = keyOf(m), mark = redraws.get(key);
      let original = m.content;
      if (mark && original === mark.original + MARK) { original = mark.original; row.message.content = stripMark(row.message.content); }
      const text = sourceText(original); if (!text) return;
      const hit = cache.get(key);
      if (hit?.original === original && (!hit.retry || hit.retry > Date.now())) {
        if (hit.translated && !row.message.content.some(n => n?.type === 'text' && n.content === label + hit.translated)) {
          row.message.content = [...row.message.content,{type:'text',content:label+hit.translated}];
        }
        return;
      }
      const pendingKey = epoch + ':' + key + ':' + original;
      if (pending.has(pendingKey) || queue.length >= MAX_QUEUE) return;
      pending.add(pendingKey); queue.push({key,pendingKey,channel:m.channel_id,id:m.id,original,text}); schedule();
    } catch (_) { status = '메시지 렌더링 호환 오류'; }
  }
  function reset() {
    epoch++; cooldownUntil = 0; if (timer !== null) clearTimeout(timer); timer = null;
    queue = []; pending.clear(); cache.clear();
    for (const key of [...redraws.keys()]) restore(key);
  }
  function SettingsComponent() {
    const R = api.common.React, N = api.common.ReactNative;
    const [input,setInput] = R.useState((api.storage.channelIds || []).join('\n'));
    const [consent,setConsent] = R.useState(!!api.storage.consent);
    const [info,setInfo] = R.useState(status);
    const [engine,setEngine] = R.useState(api.storage.engine || 'gtx');
    const [testing,setTesting] = R.useState(false);
    const [testInfo,setTestInfo] = R.useState('아직 테스트하지 않음');
    const txt = (s,style={}) => R.createElement(N.Text,{style:{color:'#b9bbbe',fontSize:15,marginBottom:12,...style}},s);
    const btn = (title,fn) => R.createElement(N.Pressable,{onPress:fn,style:{backgroundColor:'#5865f2',padding:13,borderRadius:8,marginBottom:12}},txt(title,{color:'#fff',marginBottom:0,textAlign:'center'}));
    return R.createElement(N.ScrollView,{contentContainerStyle:{padding:18}},
      txt('한국어 자동 번역 0.1.1', {fontSize:22,fontWeight:'bold',color:'#fff'}),
      txt('선택한 서버 채널의 화면에 표시되는 메시지 텍스트를 Google 번역에 전송합니다. 비공개 정보가 있는 채널은 등록하지 마세요. DM은 제외합니다.'),
      R.createElement(N.View,{style:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:16}},txt('외부 번역 전송 동의',{marginBottom:0}),R.createElement(N.Switch,{value:consent,onValueChange:v=>{api.storage.consent=v;setConsent(v);if(!v)reset();}})),
      txt('번역 서버: ' + (engine === 'web' ? 'Google 웹' : 'Google API')),
      btn('번역 서버 변경 (API ↔ 웹)',()=>{if(testing)return;const v=engine==='web'?'gtx':'web';reset();api.storage.engine=v;setEngine(v);setTestInfo('변경됨. 테스트해 주세요.');}),
      btn(testing?'테스트 중…':'번역 연결 테스트',async()=>{if(testing)return;if(!consent){setTestInfo('외부 전송 동의를 먼저 켜세요.');return;}setTesting(true);setTestInfo('테스트 중…');try{const result=await translate('Hello, how are you?',engine);setTestInfo(result?'성공: '+result:'응답은 받았지만 번역문이 비어 있음');}catch(e){setTestInfo('실패: '+errorLabel(e));}finally{setTesting(false);}}),
      txt(testInfo),
      txt('번역할 채널 ID (한 줄에 하나)'),
      R.createElement(N.TextInput,{value:input,onChangeText:setInput,multiline:true,autoCorrect:false,autoCapitalize:'none',placeholder:'123456789012345678',placeholderTextColor:'#999',style:{color:'#fff',backgroundColor:'#24252b',minHeight:90,padding:12,borderRadius:8,marginBottom:12}}),
      btn('채널 목록 저장',()=>{const ids=[...new Set(input.split(/[\s,]+/).filter(Boolean))];if(ids.some(x=>!/^\d{15,22}$/.test(x))){setInfo('채널 ID는 숫자 15~22자리여야 합니다.');return;} reset();api.storage.channelIds=ids;setInfo('저장됨. 채널을 다시 열어 주세요.');}),
      btn('번역 캐시 삭제',()=>{reset();setInfo('캐시 삭제 완료. 채널을 다시 열어 주세요.');}),
      btn('상태 새로고침',()=>setInfo(status)),txt(info));
  }
  return definePlugin({
    start(a) {
      api=a; api.storage.channelIds ??= []; api.storage.consent ??= false;
      store=api.metro.findByStoreName('MessageStore'); channels=api.metro.findByStoreName('ChannelStore'); selected=api.metro.findByStoreName('SelectedChannelStore'); users=api.metro.findByStoreName('UserStore'); dispatcher=api.common.FluxDispatcher;
      const RowManager=api.metro.findByName('RowManager');
      if (!RowManager?.prototype?.generate || !store?.getMessage || !channels?.getChannel || !selected?.getChannelId || !users?.getCurrentUser || !dispatcher?.dispatch) throw Error('Auto KO: required Discord modules not found');
      live=true;status='준비 완료 (채널 등록 필요)';api.patcher.after('generate',RowManager.prototype,onRow);
    },
    stop(){live=false;reset();status='중지됨';},
    SettingsComponent
  });
})()
