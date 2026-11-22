'use client';

import {ArrowDown,ArrowUp,ChevronDown,ChevronRight,Copy,GripVertical,Heading,Image as ImageIcon,
  Minus,Monitor,MousePointer2,Pilcrow,Smartphone,Trash2} from 'lucide-react';
import {useDeferredValue,useEffect,useId,useMemo,useRef,useState,type DragEvent} from 'react';
import {createHarborEmailBlock,createHarborEmailProject,harborEmailLimits,harborEmailProjectSchema,
  renderHarborEmail,type HarborEmailBlock,type HarborEmailProject} from '../lib/harbor-email-design';
import './portable-native-email-designer.css';

type BlockType=HarborEmailBlock['type'];
type Template='blank'|'newsletter'|'announcement';
type DropPosition={id:string;after:boolean};
const blockKinds=[
  {type:'heading',label:'Heading',icon:Heading},
  {type:'paragraph',label:'Paragraph',icon:Pilcrow},
  {type:'image',label:'Image',icon:ImageIcon},
  {type:'button',label:'Button',icon:MousePointer2},
  {type:'divider',label:'Divider',icon:Minus},
] as const;
const names:Record<BlockType,string>={heading:'Heading',paragraph:'Paragraph',image:'Image',button:'Button',divider:'Divider'};
const templates:Record<Template,string>={blank:'Blank',newsletter:'Newsletter',announcement:'Announcement'};

function blockTitle(block:HarborEmailBlock){
  switch(block.type){
    case 'heading':case 'paragraph':return block.text;
    case 'button':return block.label;
    case 'image':return block.alt;
    case 'divider':return '';
  }
}

function BlockFields({block,fieldId,disabled,update}:{block:HarborEmailBlock;fieldId:string;disabled:boolean;update:(value:HarborEmailBlock)=>void}){
  switch(block.type){
    case 'heading':return <label htmlFor={fieldId}>Heading text<input id={fieldId} value={block.text} maxLength={harborEmailLimits.heading}
      disabled={disabled} onChange={e=>update({...block,text:e.target.value})}/></label>;
    case 'paragraph':return <label htmlFor={fieldId}>Paragraph text<textarea id={fieldId} value={block.text} rows={4}
      maxLength={harborEmailLimits.paragraph} disabled={disabled} onChange={e=>update({...block,text:e.target.value})}/></label>;
    case 'image':return <>
      <label htmlFor={fieldId}>Image URL<input id={fieldId} type="url" placeholder="https://…" value={block.url}
        maxLength={harborEmailLimits.url} disabled={disabled} onChange={e=>update({...block,url:e.target.value})}/></label>
      <label htmlFor={fieldId+'-alt'}>Alt text<input id={fieldId+'-alt'} placeholder="Describe the image" value={block.alt}
        maxLength={harborEmailLimits.imageAlt} disabled={disabled} onChange={e=>update({...block,alt:e.target.value})}/></label>
    </>;
    case 'button':return <>
      <label htmlFor={fieldId}>Button label<input id={fieldId} value={block.label} maxLength={harborEmailLimits.buttonLabel}
        disabled={disabled} onChange={e=>update({...block,label:e.target.value})}/></label>
      <label htmlFor={fieldId+'-url'}>Destination URL<input id={fieldId+'-url'} type="url" placeholder="https://…" value={block.url}
        maxLength={harborEmailLimits.url} disabled={disabled} onChange={e=>update({...block,url:e.target.value})}/></label>
    </>;
    case 'divider':return null;
  }
}

function previewContent(project:HarborEmailProject){
  try{return {html:renderHarborEmail(project).html,omitted:0};}
  catch{
    // Keep the rest of a layout visible while a new image, link or text block is being filled in.
    const blocks=project.blocks.filter(block=>harborEmailProjectSchema.safeParse({...project,blocks:[block]}).success);
    const omitted=project.blocks.length-blocks.length;
    if(blocks.length&&omitted){
      try{return {html:renderHarborEmail({...project,blocks}).html,omitted};}catch{/* The complete layout may exceed the email size limit. */}
    }
    return {html:'',omitted};
  }
}

const previewPolicy='<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https: data:; base-uri \'none\'; form-action \'none\'">';
function LayoutPreview({project}:{project:HarborEmailProject}){
  const [mobile,setMobile]=useState(false);
  const deferred=useDeferredValue(project);
  const result=useMemo(()=>previewContent(deferred),[deferred]);
  const viewport=useRef<HTMLDivElement>(null);
  const [bounds,setBounds]=useState({width:0,height:0});
  useEffect(()=>{
    const node=viewport.current;
    if(!node)return;
    const observer=new ResizeObserver(([entry])=>setBounds({width:entry.contentRect.width,height:entry.contentRect.height}));
    observer.observe(node);
    return ()=>observer.disconnect();
  },[]);
  const width=mobile?375:680;
  const scale=bounds.width?Math.min(1,bounds.width/width):1;
  return <section className="native-email-preview" aria-label="Live email preview">
    <div className="native-email-panel-heading"><h4>Live preview</h4>
      <div className="native-email-viewports" role="group" aria-label="Preview width">
        <button type="button" aria-pressed={!mobile} onClick={()=>setMobile(false)}><Monitor aria-hidden="true"/>Desktop</button>
        <button type="button" aria-pressed={mobile} onClick={()=>setMobile(true)}><Smartphone aria-hidden="true"/>Mobile</button>
      </div>
    </div>
    {result.omitted>0&&<p className="native-email-hint" role="status">
      {result.omitted===1?'One unfinished block is hidden from the preview.':result.omitted+' unfinished blocks are hidden from the preview.'}</p>}
    <div className="native-email-preview-surface">
      <div ref={viewport} className="native-email-viewport">
        {result.html?<div className="native-email-sheet" style={{width:width*scale}}>
          <iframe title={mobile?'Mobile email preview':'Desktop email preview'} sandbox="" referrerPolicy="no-referrer"
            style={{width,height:bounds.height?bounds.height/scale:560,transform:'scale('+scale+')'}}
            srcDoc={result.html.replace(/<head\b[^>]*>/i,head=>head+previewPolicy)}/>
        </div>:<p className="native-email-preview-empty">{!project.blocks.length?'Add a content block to see your email.':
          result.omitted?'Complete a block to see it here.':'Check the layout fields and size to preview this email.'}</p>}
      </div>
    </div>
  </section>;
}

export function PortableNativeEmailDesigner({project,onChange,disabled}:{
  project:HarborEmailProject;onChange:(value:HarborEmailProject)=>void;disabled:boolean;
}){
  const prefix=useId();
  const root=useRef<HTMLDivElement>(null);
  const [selected,setSelected]=useState<string|null>(()=>project.blocks[0]?.id??null);
  const [pendingTemplate,setPendingTemplate]=useState<Template|null>(null);
  const [removed,setRemoved]=useState<{block:HarborEmailBlock;index:number;next?:string;previous?:string}|null>(null);
  const [announcement,setAnnouncement]=useState('');
  const [drop,setDrop]=useState<DropPosition|null>(null);
  const dragged=useRef<string|null>(null);
  const focus=useRef<{id?:string;field?:boolean}|null>(null);
  const firstAdd=useRef<HTMLButtonElement>(null);
  const atLimit=project.blocks.length>=harborEmailLimits.blocks;
  useEffect(()=>{
    const target=focus.current;
    if(!target)return;
    focus.current=null;
    const control=target.id?root.current?.ownerDocument.getElementById(prefix+'-'+target.id+(target.field?'-field':'-select')):null;
    (control??firstAdd.current)?.focus();
  },[prefix,project.blocks,selected]);
  function selectAndFocus(block?:HarborEmailBlock,field=false){
    setSelected(block?.id??null);focus.current={id:block?.id,field:field&&block?.type!=='divider'};
  }
  function changeBlocks(blocks:HarborEmailBlock[]){
    if(!disabled)onChange({...project,blocks});
  }
  function add(type:BlockType){
    if(disabled||atLimit)return;
    const block=createHarborEmailBlock(type);
    selectAndFocus(block,true);changeBlocks([...project.blocks,block]);setAnnouncement(names[type]+' added.');
  }
  function copy(index:number){
    if(disabled||atLimit)return;
    const original=project.blocks[index];
    const block={...original,id:crypto.randomUUID()};
    const items=project.blocks.slice();items.splice(index+1,0,block);
    selectAndFocus(block,true);changeBlocks(items);setAnnouncement(names[block.type]+' duplicated.');
  }
  function remove(index:number){
    if(disabled)return;
    const items=project.blocks.slice(),[block]=items.splice(index,1);
    setRemoved({block,index,next:items[index]?.id,previous:items[index-1]?.id});
    selectAndFocus(items[index]??items.at(-1));changeBlocks(items);setAnnouncement(names[block.type]+' removed. Undo is available.');
  }
  function undoRemoval(){
    if(!removed||disabled||atLimit)return;
    const items=project.blocks.slice();
    if(items.some(block=>block.id===removed.block.id)){setRemoved(null);return;}
    const next=items.findIndex(block=>block.id===removed.next),previous=items.findIndex(block=>block.id===removed.previous);
    const index=next>=0?next:previous>=0?previous+1:Math.min(removed.index,items.length);
    items.splice(index,0,removed.block);setRemoved(null);selectAndFocus(removed.block);
    changeBlocks(items);setAnnouncement(names[removed.block.type]+' restored.');
  }
  function move(from:number,to:number){
    if(disabled||from<0||to<0||from>=project.blocks.length||to>=project.blocks.length||from===to)return;
    const items=project.blocks.slice(),[block]=items.splice(from,1);items.splice(to,0,block);
    selectAndFocus(block);changeBlocks(items);setAnnouncement(names[block.type]+' moved to position '+(to+1)+' of '+items.length+'.');
  }
  function position(event:DragEvent<HTMLLIElement>){
    const box=event.currentTarget.getBoundingClientRect();
    return event.clientY>=box.top+box.height/2;
  }
  function finishDrag(){dragged.current=null;setDrop(null);}
  function applyTemplate(template:Template){
    if(disabled)return;
    const next=createHarborEmailProject(template);setPendingTemplate(null);setRemoved(null);selectAndFocus(next.blocks[0]);
    onChange(next);setAnnouncement(templates[template]+' template applied.');
  }
  return <div className="native-email-designer" ref={root} role="group" aria-label="Email layout editor">
    <div className="native-email-toolbar">
      <h3>Email layout</h3>
      <label className="native-email-template" htmlFor={prefix+'-template'}>Start from a template
        <select id={prefix+'-template'} value="" disabled={disabled} onChange={e=>{
          if(e.target.value)setPendingTemplate(e.target.value as Template);
        }}><option value="">Choose template</option>
          {Object.entries(templates).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select></label>
    </div>
    {pendingTemplate&&<div className="native-email-template-confirm" role="group" aria-label="Confirm template replacement">
      <span>Use the {templates[pendingTemplate].toLowerCase()} template? This replaces the blocks, accent, and inbox preview text.</span>
      <button type="button" disabled={disabled} onClick={()=>applyTemplate(pendingTemplate)}>Use template</button>
      <button type="button" onClick={()=>setPendingTemplate(null)}>Keep editing</button>
    </div>}
    <div className="native-email-settings">
      <label htmlFor={prefix+'-accent'}>Accent color<span className="native-email-swatch">
        <input id={prefix+'-accent'} type="color" value={project.accent} disabled={disabled}
          onChange={e=>onChange({...project,accent:e.target.value})}/><span aria-hidden="true">{project.accent.toUpperCase()}</span>
      </span></label>
      <label htmlFor={prefix+'-preheader'}>Inbox preview text <span className="native-email-optional">(optional)</span>
        <input id={prefix+'-preheader'} placeholder="The line shown after your subject" value={project.preheader} maxLength={harborEmailLimits.preheader}
          disabled={disabled} onChange={e=>onChange({...project,preheader:e.target.value})}/></label>
    </div>
    <div className="native-email-workspace">
      <section className="native-email-content" aria-label="Email content blocks">
        <div className="native-email-panel-heading"><h4>Content blocks</h4><span className="native-email-count">{project.blocks.length} of {harborEmailLimits.blocks}</span></div>
        <div className="native-email-palette" role="group" aria-label="Add a content block">
          {blockKinds.map(({type,label,icon:Icon},i)=><button key={type} type="button" ref={i===0?firstAdd:undefined}
            disabled={disabled||atLimit} aria-label={'Add '+label.toLowerCase()+' block'} onClick={()=>add(type)}>
            <Icon aria-hidden="true"/>{label}</button>)}
        </div>
        {project.blocks.length===0?<p className="native-email-empty">Choose a block above to start your email.</p>:
          <ol className="native-email-blocks">{project.blocks.map((block,index)=>{
            const open=block.id===selected,base=prefix+'-'+block.id,title=blockTitle(block).trim().replace(/\s+/g,' ').slice(0,72);
            return <li key={block.id} data-open={open||undefined} data-drop={drop?.id===block.id?(drop.after?'after':'before'):undefined}
              onDragOver={event=>{
                if(disabled||!dragged.current||dragged.current===block.id)return;
                event.preventDefault();event.dataTransfer.dropEffect='move';
                const after=position(event);
                if(drop?.id!==block.id||drop.after!==after)setDrop({id:block.id,after});
              }} onDrop={event=>{
                const id=dragged.current;
                if(!id||disabled)return;
                event.preventDefault();
                const from=project.blocks.findIndex(item=>item.id===id),boundary=index+(position(event)?1:0);
                if(id!==block.id)move(from,boundary-(from<boundary?1:0));finishDrag();
              }}>
              <div className="native-email-block-head">
                <span className="native-email-drag" draggable={!disabled} aria-hidden="true" title="Drag to reorder"
                  onDragStart={event=>{
                    if(disabled){event.preventDefault();return;}
                    dragged.current=block.id;event.dataTransfer.effectAllowed='move';
                    event.dataTransfer.setData('application/x-harbor-email-block',block.id);
                  }} onDragEnd={finishDrag}><GripVertical/></span>
                <button className="native-email-block-select" id={base+'-select'} type="button" aria-expanded={open}
                  aria-controls={open?base+'-fields':undefined} onClick={()=>setSelected(open?null:block.id)}>
                  <span>{names[block.type]}</span>{title&&<span className="native-email-excerpt">{title}</span>}
                  {open?<ChevronDown aria-hidden="true"/>:<ChevronRight aria-hidden="true"/>}
                </button>
              </div>
              {open&&<div className="native-email-block-fields" id={base+'-fields'}>
                <BlockFields block={block} fieldId={base+'-field'} disabled={disabled}
                  update={next=>changeBlocks(project.blocks.map(item=>item.id===block.id?next:item))}/>
                <div className="native-email-block-actions" role="group" aria-label={names[block.type]+' block actions'}>
                  <button type="button" aria-label="Move block up" title="Move up" disabled={disabled||index===0} onClick={()=>move(index,index-1)}><ArrowUp/></button>
                  <button type="button" aria-label="Move block down" title="Move down" disabled={disabled||index===project.blocks.length-1} onClick={()=>move(index,index+1)}><ArrowDown/></button>
                  <button type="button" aria-label="Duplicate block" title="Duplicate" disabled={disabled||atLimit} onClick={()=>copy(index)}><Copy/></button>
                  <button type="button" aria-label="Remove block" title="Remove" disabled={disabled} onClick={()=>remove(index)}><Trash2/></button>
                </div>
              </div>}
            </li>;
          })}</ol>}
        {removed&&<div className="native-email-undo"><span>{names[removed.block.type]} removed.</span>
          <button type="button" disabled={disabled||atLimit} aria-label="Undo block removal" onClick={undoRemoval}>Undo</button>
        </div>}
        <span className="native-email-sr-only" role="status">{announcement}</span>
      </section>
      <LayoutPreview project={project}/>
    </div>
  </div>;
}
