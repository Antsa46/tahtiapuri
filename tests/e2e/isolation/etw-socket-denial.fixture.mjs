import {candidateFixture} from './etw-candidate.fixture.mjs';
export function socketDenialFixture(kind='normal') {
  const f=candidateFixture(kind);
  for(const r of f.cases[1].records) {
    if(r.type==='network-detail')Object.assign(r,{stage:'socket',code:10013,localAddress:'',localPort:0,localEndpointError:10038});
    if(r.type==='operation'&&['tcp4','tcp6','udp4','udp6'].includes(r.name))r.code=10013;
  }
  f.evidence.records=f.evidence.records.filter(r=>r.kind!=='event');
  const end=f.evidence.records.at(-1);
  for(const key of ['received','matchedEvents','providerMismatch','otherEventId','emptyAppId','otherAppId','otherEndpoint','ntMatches','dosMatches'])end[key]=0;
  return f;
}
