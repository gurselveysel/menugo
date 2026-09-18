'use client';
import {useEffect,type RefObject} from 'react';
/** Measure real bars; do not mask overflow with a global overflow-x:hidden. */
export function useMerchantViewport(rootRef:RefObject<HTMLDivElement|null>) {
  useEffect(()=>{
    const root=rootRef.current;if(!root)return;
    const dock=root.querySelector<HTMLElement>('.merchant-bottom');
    const tabs=root.querySelector<HTMLElement>('.merchant-tabs');
    const update=()=>{
      if(dock)root.style.setProperty('--merchant-dock-height',Math.ceil(dock.getBoundingClientRect().height)+'px');
      if(tabs)root.style.setProperty('--merchant-tabs-height',Math.ceil(tabs.getBoundingClientRect().height)+'px');
      const active=document.activeElement;
      const isInput=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement;
      const viewport=window.visualViewport;
      const keyboard=!!viewport&&viewport.scale===1&&window.innerHeight-viewport.height>160&&isInput;
      root.dataset.keyboardOpen=keyboard?'true':'false';
    };
    const observer=new ResizeObserver(update);
    if(dock)observer.observe(dock);if(tabs)observer.observe(tabs);
    update();window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update);
    document.addEventListener('focusin',update);document.addEventListener('focusout',update);
    return()=>{observer.disconnect();window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update);document.removeEventListener('focusin',update);document.removeEventListener('focusout',update);};
  },[rootRef]);
}
