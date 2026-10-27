import {demand} from './access-store.mjs';

// Explicit allowlist. A new endpoint stays closed until classified here.
const reads=new Set(['/api/bootstrap','/api/documents','/api/documents/original','/api/coverage','/api/taxonomy','/api/proposals','/api/history','/api/evidence','/api/export','/api/corpus-plan','/api/generations']);
const posts=new Set(['/api/documents','/api/import','/api/turns','/api/index','/api/proposals','/api/semantic/extract','/api/semantic/review','/api/corpus-plan','/api/generations/replay']);
const operations={
 '/api/graph-publication':{read:['status','query','original','capabilities'],write:['publish']},
 '/api/causal':{read:['sources','source','get','history','query','page','original','snapshotItem'],write:['put']},
 '/api/decision-intelligence':{read:['sources','source','get','history','query','page','original','snapshotItem'],write:['put']},
 '/api/retrospectives':{read:['sources','source','get','history','query','page','original','snapshotItem'],write:['put']},
 '/api/volume':{read:['status','page','verify'],write:['sync','lake']},
 '/api/semantic':{read:['list','get','history','query'],write:['correct']},
 '/api/learning':{read:['sources','get','query','history'],write:['record']},
 '/api/decisions':{read:['sources','list','get','history'],write:['frame','act']},
 '/api/collectives':{read:['sources','list','get','query','history'],write:['put']},
 '/api/supports':{read:['sources','get','history','evaluate','impact'],write:['put','review']},
 '/api/identities':{read:['sources','source','get','query','history','page','original','snapshotItem'],write:['put']},
 '/api/publication':{read:['status','query'],write:['run']},
 '/api/reevaluation':{read:['list','get','status'],write:[]},
 '/api/routing':{read:['status','get'],write:['classify','correct']}
};
export function requestRole(method,pathname,body={}){
 if(pathname==='/api/volume')demand(body.backend!=='postgres'&&body.op!=='postgres','ACCESS_MANAGED_POSTGRES_NOT_ADMITTED',403);
 if(method==='GET'&&(reads.has(pathname)||/^\/api\/(answers|jobs)\/[a-f0-9-]{36}$/.test(pathname)))return 'reader';
 if(method==='POST'&&['/api/retrieve','/api/context/page','/api/explorer'].includes(pathname))return 'reader';
 if(method==='POST'&&pathname==='/api/ask')return 'editor';
 if(method==='POST'&&/^\/api\/jobs\/[a-f0-9-]{36}\/cancel$/.test(pathname))return 'editor';
 if(method==='POST'&&posts.has(pathname)){demand(!(pathname==='/api/import'&&body.url),'ACCESS_UPLOAD_ONLY',403);return 'editor';}
 const ops=operations[pathname];if(method==='POST'&&ops){const op=body.op??(pathname==='/api/routing'?'classify':'');if(ops.read.includes(op))return 'reader';if(ops.write.includes(op))return 'editor';}
 demand(false,'ACCESS_ROUTE_NOT_ADMITTED',403);
}
