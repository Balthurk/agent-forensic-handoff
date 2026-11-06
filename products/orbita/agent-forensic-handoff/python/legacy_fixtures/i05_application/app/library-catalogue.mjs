import {library,refreshLibrary,getLibrary} from './corpus.mjs';

// The catalogue is navigation metadata. It never grants source access or marks
// bytes as verified; retrieval still checks the selected originals in full.
export async function bootstrapLibrary({catalogue=false}={}){
 if(!catalogue)return {library:await getLibrary()};
 (await import('./documents.mjs')).reconcileDocuments();refreshLibrary();
 if(library.length<=100)return {library:await getLibrary()};
 return {libraryMode:'catalogue',maxSelection:20,library:library.map(item=>({
  ...item,path:undefined,verified:false,verificationStatus:'on-demand',
  messages:undefined,records:undefined,hash:undefined,error:undefined,
  coverage:'NOT_VERIFIED_FOR_THIS_REQUEST',roles:null
 }))};
}
