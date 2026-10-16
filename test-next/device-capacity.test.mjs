import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCapacityFields } from '../src/device-capacity.mjs';
const profile = 'hrstorage-normalized-v1';
const storage = { type:'hrstorage', storage_index:1, storage_used_oid:'.1.3.6.1.2.1.25.2.3.1.6.1', storage_perc_oid:'', storage_units:4096, storage_size:100, storage_used:25, storage_free:75, storage_perc:25 };
test('verified byte fields are closed, already normalized and have unknown times',()=>{
 const result=projectCapacityFields(storage,'storage',profile); assert.equal(result.total_bytes.value,100); assert.equal(result.used_bytes.value,25);
 for(const field of Object.values(result).filter(x=>typeof x==='object'&&x!==null)){assert.deepEqual(Object.keys(field),['value','unit','state','missing_reason','source_kind','observed_at','received_at','capacity_basis','evidence']);assert.equal(field.observed_at,null);assert.equal(field.received_at,null);assert.notEqual(field.state,'available');}
});
test('profile, OID, index, type and positive multiplier all required for bytes',()=>{
 for(const profileName of [undefined,'unknown'])assert.equal(projectCapacityFields({...storage,capacity_basis:'absolute'},'storage',profileName).total_bytes.value,null);
 for(const patch of [{type:'vendor'},{storage_index:0},{storage_used_oid:'wrong'},{storage_perc_oid:'percent-only'},{storage_units:0}])assert.equal(projectCapacityFields({...storage,...patch},'storage',profile).total_bytes.value,null);
});
test('zero usage is retained; unsafe numbers, fractions and inconsistent capacity fail',()=>{
 const zero=projectCapacityFields({...storage,storage_used:0,storage_free:100,storage_perc:0},'storage',profile);assert.equal(zero.used_bytes.value,0);assert.equal(zero.used_percent.value,0);
 for(const patch of [{storage_free:99},{storage_size:'9007199254740991.1'},{storage_used:true},{storage_used:25.5},{storage_size:Infinity}]){const x=projectCapacityFields({...storage,...patch},'storage',profile);assert.equal(x.total_bytes.state,'read_failed');assert.equal(x.used_percent.value,null);}
});
test('CPU monitoring does not imply hardware specifications',()=>{
 const x=projectCapacityFields({processor_usage:'50.5',core_count:16,processor_count:16,frequency_hz:3e9},'processor');assert.equal(x.usage_percent.value,50.5);for(const key of ['core_count','thread_count','frequency_hz']){assert.equal(x[key].value,null);assert.equal(x[key].state,'not_collected');}
});
test('missing, invalid and zero percentage are distinct',()=>{
 assert.equal(projectCapacityFields({},'processor').usage_percent.state,'not_collected');for(const value of [true,'',101,-1,NaN])assert.equal(projectCapacityFields({processor_usage:value},'processor').usage_percent.state,'read_failed');assert.equal(projectCapacityFields({processor_usage:0},'processor').usage_percent.value,0);
});
test('mempool has its own lineage and no raw fields escape',()=>{
 const x=projectCapacityFields({mempool_type:'hrstorage',mempool_index:'2',mempool_used_oid:'.1.3.6.1.2.1.25.2.3.1.6.2',mempool_precision:1024,mempool_total:'40.0',mempool_used:'10',mempool_free:'30',mempool_perc:25,password:'SYNTHETIC-SENSITIVE'},'mempool',profile);assert.equal(x.total_bytes.value,40);assert.equal(x.total_bytes.evidence.source_field,'mempool_total');assert.doesNotMatch(JSON.stringify(x),/SYNTHETIC-SENSITIVE|used_oid|mempool_index/);assert.throws(()=>projectCapacityFields({},'lldp'),{code:'CAPACITY_INVALID_ARGUMENT'});
});
