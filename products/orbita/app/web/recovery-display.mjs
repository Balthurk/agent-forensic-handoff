const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():null;

export function recoveryStatusText(state){
 if(!state)return 'Este almacén no tiene una importación o restauración registrada.';
 const imported=/^orbita-legacy-plan-[12]$/.test(state.sourceFormat),when=date(state.restoredAt),files=count(state.files??state.archiveFiles);
 const lines=[imported?'Importación registrada en PostgreSQL':when?'Última restauración registrada':'Control de recuperación registrado'];
 if(!imported&&files!==null)lines.push(`${files} archivos en el corte`);
 if(when)lines.push(`Fecha de restauración: ${when}`);
 if(imported)lines.push('La importación conserva su recibo original; no registra aquí una fecha de restauración ni un recuento de archivos.');
 lines.push('El recibo corresponde a ese corte; no incluye cambios posteriores.');
 lines.push(`Automáticas: ${state.automaticWork===true?'activas':'pausadas'} · rutas externas: ${state.externalAccess===true?'permitidas':'pausadas'}`);
 return lines.join('\n');
}

export function recoveryJobText(job){
 if(job.admission?.state==='waiting'&&job.status==='running'){
  const a=job.admission,parts=[];
  for(const [key,label] of [['http','solicitudes'],['background','trabajos de fondo'],['automatic','tareas automáticas']])if(count(a[key])!==null)parts.push(`${a[key]} ${label}`);
  const deadline=date(a.deadlineAt);
  return `Esperando a que terminen las operaciones activas.\n${parts.join(' · ')}${deadline?'\nLímite de espera: '+deadline:''}\nPuedes cancelar esta espera sin crear un archivo.`;
 }
 if(job.status==='cancelled')return 'Espera cancelada. No se inició la recuperación.';
 if(job.error==='RECOVERY_DRAIN_TIMEOUT')return 'Se agotó la espera de las operaciones activas. No se inició la recuperación; puedes reintentarlo cuando terminen.';
 if(job.error?.startsWith('RECOVERY_STORE_BUSY'))return 'Otro proceso mantiene abierto el almacén. Cierra esa operación y vuelve a intentar el respaldo.';
 return job.error||job.phase||'Procesando recuperación…';
}
