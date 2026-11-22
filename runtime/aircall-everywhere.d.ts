declare module 'aircall-everywhere' {
  export class AircallWorkspace {
    constructor(options:{
      window:{addEventListener:(name:string,listener:(event:MessageEvent)=>void)=>void};
      onLogin:()=>void;onLogout:()=>void;debug:boolean;
    });
    getUrlToLoad():string;
    on(event:'outgoing_call'|'outgoing_answered'|'call_ended',listener:(data:unknown)=>void):void;
    send(event:'dial_number',data:{phone_number:string},callback:(success:boolean)=>void):void;
  }
  const entry:typeof AircallWorkspace|{default:typeof AircallWorkspace};
  export default entry;
}
