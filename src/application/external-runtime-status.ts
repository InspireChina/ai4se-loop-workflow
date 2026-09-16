import type {RuntimeHostAudit} from '../domain/runtime-host-audit';

/** Independent control facts remain available when the business diagnostic
 * capability cannot read its database. No error text or environment is exposed. */
export function createExternalRuntimeStatus<Control,Hosts>(ports:{
  control:()=>Control;hosts:()=>Hosts;inspectBusiness:()=>Promise<RuntimeHostAudit>;
  onError?:(error:unknown)=>void;
}){
  return async()=>{
    let business:RuntimeHostAudit|undefined;let businessError:string|undefined;
    try{business=await ports.inspectBusiness();}
    catch(error){
      try{ports.onError?.(error);}catch{/* Diagnostics must not hide the control plane. */}
      const code=(error as {code?:unknown})?.code;
      businessError=typeof code==='string'&&/^[A-Z_]{1,64}$/.test(code)?code:'BUSINESS_DIAGNOSTIC_UNAVAILABLE';
    }
    return {control:ports.control(),hosts:ports.hosts(),business,businessError,observedAt:new Date().toISOString()};
  };
}
