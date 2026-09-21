export async function assistantCommandChecks({q,db,auth,check,rejects,b,br,users,op,p1}){
 await auth(users[2]);
 await rejects('customer cannot list assistant commands',()=>q("select ops.assistant_command($1,$2,'list','{}')",[b,br]),'MANAGER_REQUIRED');
 await auth(users[0]);
 const command=async(action,payload={})=>(await q('select ops.assistant_command($1,$2,$3,$4::jsonb) j',[b,br,action,JSON.stringify(payload)]))[0].j;
 const initial=await command('list');const product=initial.products.find(x=>x.id===p1);check('assistant command list is scoped and catalogue-backed',initial.scopeKey===b+':'+br+':'+users[0]&&!!product);
 await db.exec('reset role');const beforePrice=(await q('select approved_price::text price,available,updated_at::text updated from public.menu_items where id=$1',[p1]))[0];await auth(users[0]);
 const request={operationId:op(93001),productId:p1,expectedUpdatedAt:product.updatedAt,available:!product.available,confirmed:true,reason:'Isolated assistant availability test'};
 const applied=await command('set-product-availability',request);check('explicit assistant command changes only availability',applied.productId===p1&&applied.available===!product.available&&applied.priceChanged===false);
 const replay=await command('set-product-availability',request);check('assistant command retry is idempotent',replay.commandId===applied.commandId&&replay.duplicate===true);
 await rejects('same assistant operation cannot change intent',()=>command('set-product-availability',{...request,available:product.available}),'IDEMPOTENCY_CONFLICT');
 await rejects('stale assistant product revision rejected',()=>command('set-product-availability',{...request,operationId:op(93002)}),'PRODUCT_CHANGED');
 await db.exec('reset role');const afterApply=(await q('select approved_price::text price,available from public.menu_items where id=$1',[p1]))[0];await auth(users[0]);check('assistant command never changes price',afterApply.price===beforePrice.price&&afterApply.available===!product.available);
 await rejects('manager cannot directly read assistant journal',()=>q('select * from ops.assistant_commands'),'42501');
 const undone=await command('undo-product-availability',{operationId:op(93003),commandId:applied.commandId,confirmed:true,reason:'Isolated assistant undo test'});check('confirmed undo restores prior availability',undone.reversedCommandId===applied.commandId&&undone.available===product.available&&undone.priceChanged===false);
 const undoReplay=await command('undo-product-availability',{operationId:op(93003),commandId:applied.commandId,confirmed:true,reason:'Isolated assistant undo test'});check('assistant undo replay is idempotent',undoReplay.commandId===undone.commandId&&undoReplay.duplicate===true);
 await rejects('separate second undo cannot erase newer state',()=>command('undo-product-availability',{operationId:op(93004),commandId:applied.commandId,confirmed:true,reason:'Second undo must fail safely'}),'COMMAND_ALREADY_UNDONE');
 await db.exec('reset role');const afterUndo=(await q('select approved_price::text price,available from public.menu_items where id=$1',[p1]))[0];await auth(users[0]);check('undo preserves exact price and restores state',afterUndo.price===beforePrice.price&&afterUndo.available===beforePrice.available);
 const fresh=(await command('list')).products.find(x=>x.id===p1);const second=await command('set-product-availability',{operationId:op(93005),productId:p1,expectedUpdatedAt:fresh.updatedAt,available:!fresh.available,confirmed:true,reason:'Create conflict-safe undo fixture'});
 await db.exec('reset role');await q('update public.menu_items set updated_at=clock_timestamp()+interval \'1 second\' where id=$1',[p1]);await auth(users[0]);
 await rejects('undo refuses to overwrite a newer product change',()=>command('undo-product-availability',{operationId:op(93006),commandId:second.commandId,confirmed:true,reason:'Must not erase subsequent edit'}),'PRODUCT_CHANGED');
 await db.exec('reset role');await q('update public.menu_items set available=$1 where id=$2',[beforePrice.available,p1]);
}
