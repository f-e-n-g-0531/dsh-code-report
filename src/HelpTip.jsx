import React,{useId,useState} from 'react';

export function HelpTipIcon(){
 return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
  <circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 3.7"/><path d="M12 16h.01"/>
 </svg>;
}

export default function HelpTip({label,children}){
 const id=useId(),[open,setOpen]=useState(false);
 return <span className="cr-help-tip" onMouseLeave={()=>setOpen(false)}>
  <button type="button" className="cr-help-trigger" aria-label={label+'说明'} aria-describedby={id}
   onMouseEnter={()=>setOpen(true)} onFocus={()=>setOpen(true)} onBlur={()=>setOpen(false)} onClick={()=>setOpen(true)}
   onKeyDown={event=>{if(event.key==='Escape')setOpen(false);}}><HelpTipIcon/></button>
  <span id={id} role="tooltip" className="cr-tip cr-help-popup" hidden={!open}>{children}</span>
 </span>;
}
