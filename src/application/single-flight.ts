/** Share one in-flight operation across every caller, then admit a new run
 * only after the previous promise has settled. */
export function createSingleFlight<T>(operation:()=>Promise<T>){
  let pending:Promise<T>|undefined;
  return {
    run(){
      if(!pending)pending=Promise.resolve().then(operation).finally(()=>{pending=undefined;});
      return pending;
    },
    current(){return pending;},
  };
}
