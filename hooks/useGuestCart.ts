 'use client';
import {useEffect,useMemo,useSyncExternalStore} from 'react';
import {createClient} from '@supabase/supabase-js';
import {LiveCartStore,type RealtimePort} from '@/src/live-cart';
import {fromHttp,scopeOf,type Scope} from '@/src/cart-protocol';
import {sessionCommandJournal} from '@/src/cart-journal';
export function useGuestCart(input:Scope){
 const store=useMemo(()=>{
  const scope=scopeOf(input);let client:ReturnType<typeof createClient>|undefined;let closing=Promise.resolve();
  const realtime:RealtimePort={async listen(id,changed,status,signal){
   await closing;if(signal.aborted)return;
   client??=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
   // Separate read-only capability channel. No customer or staff Auth token is reused.
   const channel=client.channel('check:'+id,{config:{private:true,broadcast:{self:false}}});
   const remove=()=>{closing=client!.removeChannel(channel).then(()=>{}).catch(()=>{});};
   signal.addEventListener('abort',remove,{once:true});if(signal.aborted){remove();return;}
   channel.on('broadcast',{event:'changed'},m=>{if(!signal.aborted)changed(m.payload);}).subscribe(value=>{if(!signal.aborted)status(value);});
  }};
  async function request(action:string,signal:AbortSignal,body?:unknown){const res=await fetch('/api/guest/'+scope.checkId+'/'+action,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const json=await res.json();if(!res.ok)throw fromHttp(res.status,json);return json;}
  return new LiveCartStore(scope,{snapshot:signal=>request('cart',signal),post:(command,signal)=>request('cart',signal,command),realtime,journal:sessionCommandJournal(scope),newOperationId:()=>crypto.randomUUID(),pollMs:15000});
 },[input.businessId,input.branchId,input.checkId,input.userId]);
 const state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getServerSnapshot);
 useEffect(()=>{store.start(navigator.onLine,document.visibilityState==='visible');const online=()=>store.setOnline(true),offline=()=>store.setOnline(false),visible=()=>store.setVisible(document.visibilityState==='visible'),focus=()=>store.wake();window.addEventListener('online',online);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',visible);window.addEventListener('focus',focus);return()=>{window.removeEventListener('online',online);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',focus);store.stop();};},[store]);
 return {...state,canMutate:store.canMutate(),mutateCart:store.mutateCart,retryPending:store.retryPending,refresh:store.refresh};
}
