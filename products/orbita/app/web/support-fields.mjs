export const sameDecision=(a,b)=>['caseId','version','digest'].every(k=>a?.[k]===b?.[k]);
