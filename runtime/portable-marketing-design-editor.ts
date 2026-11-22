// This is the browser loader used by Beefree's official SDK package.
const loader='https://app-rsrc.getbee.io/plugin/v2/BeePlugin.js';
type Token={access_token:string;v2:true};
export type DesignSession={uid:string;token:Token};
type Project=Record<string,unknown>;
type Builder={start(project:Project):void;save():void|Promise<unknown>;destroy?():void;updateToken(token:Token):void};
type EditorEvents={onLoad():void;onChange():void;onSave(project:string,html:string):void;onError(error:{code?:number;template?:Project}):void};
type BeePlugin={create(token:Token,config:EditorEvents&{uid:string;container:string;language:string;trackChanges:true},ready:(instance:Builder)=>void):void};

let loading:Promise<BeePlugin>|undefined;
function loadPlugin():Promise<BeePlugin>{
  const provider=window as Window&{BeePlugin?:BeePlugin};
  if(provider.BeePlugin)return Promise.resolve(provider.BeePlugin);
  if(loading)return loading;
  const script=document.createElement('script');
  script.src=loader;script.async=true;script.referrerPolicy='no-referrer';
  loading=new Promise((resolve,reject)=>{
    const timeout=window.setTimeout(failed,15_000);
    function failed(){
      window.clearTimeout(timeout);script.remove();loading=undefined;
      reject(Error('Could not load the Beefree editor. Reopen it to try again.'));
    }
    script.onload=()=>{
      window.clearTimeout(timeout);
      if(provider.BeePlugin)resolve(provider.BeePlugin);else failed();
    };
    script.onerror=failed;
    document.head.appendChild(script);
  });
  return loading;
}

type Events={ready():void;changed():void;saved(project:string,html:string):void;error(message:string):void};
export function openBeefreeEditor(container:string,initialProject:string|undefined,
  session:()=>Promise<DesignSession>,events:Events,plugin:()=>Promise<BeePlugin>=loadPlugin){
  let instance:Builder|undefined,closed=false,refreshing=false;
  let pendingLoad:ReturnType<typeof setTimeout>|undefined;
  const initial=initialProject?JSON.parse(initialProject):{comments:{},page:{}};
  const error=()=>{if(!closed)events.error('Beefree could not complete this operation. Reopen the editor or try saving again.');};
  async function start(project:Project){
    try{
      // Authorize first so opening a workspace without configured credentials never loads the vendor script.
      const {uid,token}=await session();
      if(closed)return;
      const sdk=await plugin();
      if(closed)return;
      clearTimeout(pendingLoad);
      pendingLoad=setTimeout(()=>{if(!closed)events.error('The editor is taking too long. Close it and open it again.');},30_000);
      sdk.create(token,{container,uid,language:'en-US',trackChanges:true,
        onLoad:()=>{clearTimeout(pendingLoad);if(!closed)events.ready();},onChange:()=>{if(!closed)events.changed();},
        onSave:(json,html)=>{if(!closed)events.saved(json,html);},
        onError:({code,template})=>{
          if(closed||refreshing)return;
          if(code===5101&&instance){
            refreshing=true;
            void session().then(next=>{if(!closed)instance?.updateToken(next.token);}).catch(error).finally(()=>{refreshing=false;});
          }else if(code===5102&&template){
            instance?.destroy?.();instance=undefined;
            refreshing=true;
            void start(template).finally(()=>{refreshing=false;});
          }else error();
        },
      },builder=>{
        if(closed){builder.destroy?.();return;}
        instance=builder;try{builder.start(project);}catch{clearTimeout(pendingLoad);error();}
      });
    }catch(failure){
      if(!closed)events.error(failure instanceof Error?failure.message:'Could not open Beefree.');
    }
  }
  void start(initial);
  return {
    save(){try{if(instance)void Promise.resolve(instance.save()).catch(error);}catch{error();}},
    close(){closed=true;clearTimeout(pendingLoad);instance?.destroy?.();instance=undefined;},
  };
}
