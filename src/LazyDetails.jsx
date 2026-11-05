import React,{useState} from 'react';

// Keep closed sections out of the DOM, not merely hidden by <details>.
export default function LazyDetails({summary,children,...props}){
 const [open,setOpen]=useState(false);
 return <details {...props} open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{summary}</summary>{open?children():null}</details>;
}
