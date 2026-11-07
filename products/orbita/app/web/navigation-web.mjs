// Move the existing controls; their handlers, permission annotations and state
// remain attached. Order is explicit and independent of module loading order.
const groups=[
 {id:'sources',label:'Fuentes y archivo',actions:['import-conversation','import-document','coverage','volume','recovery','capture']},
 {id:'explore',label:'Explorar la memoria',actions:['graph','explanations','history','identities']},
 {id:'decisions',label:'Decisiones y aprendizaje',actions:['decision-cases','decision-learning','supports','collectives','learning','reevaluation']},
];
const panels={capture:['capturePanel','Conversaciones en curso'],learning:['learningPanel','Aprendizajes y límites'],'decision-cases':['decisionPanel','Casos de decisión'],reevaluation:['reevaluationPanel','Reevaluar con nueva información']};

export function initialiseNavigation(){
 const sidebar=document.querySelector('.sidebar'),anchor=document.querySelector('#addSource');
 if(!sidebar||!anchor||document.querySelector('#taskNavigation'))return;
 const nav=document.createElement('nav');nav.id='taskNavigation';nav.className='task-navigation';nav.setAttribute('aria-label','Acciones por tarea');
 const selection=document.createElement('button');selection.type='button';selection.className='navigation-selection';selection.id='reviewSources';
 selection.onclick=()=>{const input=document.querySelector('#library input:checked:not(:disabled)')||document.querySelector('#library input:not(:disabled)');if(input){input.focus();input.scrollIntoView({block:'nearest'});}};
 const update=()=>{const count=document.querySelectorAll('#library input:checked').length;const label='Revisar fuentes · '+count+' seleccionadas';if(selection.textContent!==label)selection.textContent=label;selection.disabled=!document.querySelector('#library input:not(:disabled)');};
 nav.append(selection);const hosts=new Map();
 for(const group of groups){const details=document.createElement('details');details.dataset.navigationGroup=group.id;details.open=group.id==='sources';const summary=document.createElement('summary');summary.textContent=group.label;details.append(summary);const host=document.createElement('div');host.className='navigation-actions';details.append(host);nav.append(details);hosts.set(group.id,host);}
 sidebar.insertBefore(nav,anchor);anchor.dataset.navigationAction='import-conversation';
 function reconcile(){
  const focus=document.activeElement;
  for(const [action,[id,label]] of Object.entries(panels)){
   const panel=document.getElementById(id);if(!panel||nav.querySelector('[data-navigation-action="'+action+'"]'))continue;
   const button=document.createElement('button');button.type='button';button.className='add-source';button.dataset.navigationAction=action;button.textContent=label;
   button.onclick=()=>{panel.open=true;const summary=panel.querySelector('summary');summary.focus();summary.scrollIntoView({block:'center',behavior:'smooth'});};
   hosts.get(groups.find(g=>g.actions.includes(action)).id).append(button);
  }
  for(const group of groups){const host=hosts.get(group.id),wanted=group.actions.map(id=>document.querySelector('[data-navigation-action="'+id+'"]')).filter(Boolean);
   for(let i=0;i<wanted.length;i++)if(host.children[i]!==wanted[i])host.insertBefore(wanted[i],host.children[i]||null);
  }
  if(focus?.isConnected&&document.activeElement!==focus)focus.focus({preventScroll:true});
  update();
 }
 reconcile();const observer=new MutationObserver(reconcile);observer.observe(sidebar,{childList:true,subtree:true});
 const composer=document.querySelector('.composer-area');if(composer)observer.observe(composer,{childList:true,subtree:true});
 document.addEventListener('orbita-selection-changed',update);
 return observer;
}
