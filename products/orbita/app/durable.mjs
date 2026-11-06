// Compatibility names retain the explicit common-store contract. No native DB.
export {sha,now,writeDurable,writeJSON,openDB,transaction,checkpoint} from './common-durable.mjs';
