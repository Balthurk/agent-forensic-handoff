// Input provenance is an explicit caller choice, never a filesystem fallback.
import native from 'node:fs';
import common from './common-files.js';
import {hashFile as hashNative} from './util.js';
import {hashFile as hashCommon} from './common-util.js';
export function inputStorage(name='native'){
  if(name==='native')return {files:native,hashFile:hashNative,common:false};
  if(name==='postgresql-common')return {files:common,hashFile:hashCommon,common:true};
  throw Object.assign(new Error('ORBITA_INPUT_STORAGE_REQUIRED'),{code:'ORBITA_INPUT_STORAGE_REQUIRED'});
}
