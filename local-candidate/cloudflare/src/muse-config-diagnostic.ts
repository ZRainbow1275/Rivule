/** Owner-authorized, transient configuration checks. Never return/log the value,
 * its length, its hash, or arbitrary environment fields. This does not change
 * authentication policy and must run only after the existing owner read succeeds.
 */
export async function appendMuseConfiguration(
 authorizedRead:()=>Promise<Record<string,unknown>>,
 env:Record<string,unknown>
):Promise<Record<string,unknown>>{
 const result=await authorizedRead();
 const value=env.PA_MUSE_API_KEY;
 const isString=typeof value==='string';
 return {...result,muse_configuration:{
  binding_present:value!==undefined,
  string_type:isString,
  length_valid:isString&&value.length>=32&&value.length<=512,
  characters_valid:isString&&/^[A-Za-z0-9._~+/=-]*$/.test(value)
 }};
}
