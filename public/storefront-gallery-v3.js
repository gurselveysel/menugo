(() => {
  'use strict';
  const gallery = document.querySelector('.storefront-gallery');
  const modal = document.getElementById('storefront-dialog');
  if (!gallery || !modal) return;
  const main = document.getElementById('storefront-main');
  const full = document.getElementById('storefront-full');
  const link = gallery.querySelector('[data-storefront-open]');
  const choices = [
    {key:'wide',src:'/media/sariyer-storefront-wide-v3.jpg',alt:'Meşhur Sarıyer Börekçisi Sandviç: dış cephe görünümü'},
    {key:'detail',src:'/media/sariyer-storefront-detail-v3.jpg',alt:'Meşhur Sarıyer Börekçisi Sandviç: mağaza görünümü'}
  ];
  let current = 0;
  function select(index) {
    current = (index + choices.length) % choices.length;
    const item = choices[current];
    main.src = item.src;
    main.alt = item.alt;
    link.href = item.src;
    if (modal.open) { full.src = item.src; full.alt = item.alt; }
    gallery.querySelectorAll('[data-storefront-select]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.storefrontSelect === item.key)));
    document.getElementById('storefront-position').textContent = `${current + 1} / ${choices.length}`;
  }
  gallery.querySelectorAll('[data-storefront-select]').forEach(button => button.addEventListener('click',() => {
    const index = choices.findIndex(item => item.key === button.dataset.storefrontSelect);
    if (index >= 0) select(index);
  }));
  link.addEventListener('click',event => {
    if (typeof modal.showModal !== 'function') return;
    event.preventDefault();
    const item = choices[current];
    full.src = item.src;
    full.alt = item.alt;
    modal.showModal();
    document.body.classList.add('storefront-dialog-open');
  });
  modal.querySelector('.storefront-dialog-close').addEventListener('click',() => modal.close());
  modal.querySelectorAll('[data-storefront-step]').forEach(button => button.addEventListener('click',() => select(current + Number(button.dataset.storefrontStep))));
  modal.addEventListener('keydown',event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();select(current + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  modal.addEventListener('close',() => document.body.classList.remove('storefront-dialog-open'));
  modal.addEventListener('click',event => {
    if (event.target !== modal) return;
    const r=modal.getBoundingClientRect();
    if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();
  });
})();
