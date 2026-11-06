import {intelligenceFixture} from './decision-intelligence-fixture.mjs';
export async function causalFixture(){
 const f=await intelligenceFixture(),ev=f.evidence;
 const hypothesis=(key,position='supports')=>({key,text:'Hipótesis sintética '+key,kind:'hypothesis',attributedTo:null,mechanism:null,method:'temporal_sequence',evidence:[{...ev[0],position,basis:'sequence'}],assumptions:[{key:'disco',text:'Disponibilidad de disco desconocida',assessment:'unknown',evidence:ev}],counterfactual:null});
 return {...f,detail:{title:'Explicaciones de recuperación · sintético',actor:'fixture',reason:'Comparar hipótesis sin inferir causa',state:'active',context:f.context.reference,decision:null,effect:{text:'Se declaró recuperación',evidence:ev},scope:{text:'Laboratorio sintético',validFrom:null,validUntil:null,evidence:ev},hypotheses:[hypothesis('copy'),hypothesis('other','contradicts')],gaps:['No es un caso causal validado.']}};
}
