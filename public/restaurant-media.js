(() => {
  'use strict';
  const dialog = document.getElementById('media-dialog');
  if (!dialog) return;
  const image = document.getElementById('media-dialog-image');
  const assets = {
    wide: {src:'/media/sariyer-wide.avif', width:840, height:472, alt:'Meşhur Sarıyer Börekçisi Sandviç yatay tanıtım afişi; sandviçler ve waffle, telefon 0539 483 00 31'},
    portrait: {src:'/media/sariyer-portrait.avif', width:512, height:640, alt:'Meşhur Sarıyer Börekçisi Sandviç dikey tanıtım afişi; kruvasan, baget ve kova waffle, telefon 0539 483 00 31'}
  };
  function choose(key) {
    const selected = key === 'auto' ? (matchMedia('(max-width:700px)').matches ? 'portrait' : 'wide') : key;
    const item = assets[selected];
    if (!item) return;
    image.src = item.src;
    image.alt = item.alt;
    image.width = item.width;
    image.height = item.height;
    dialog.dataset.layout = selected;
    dialog.querySelectorAll('[data-media-layout]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.mediaLayout === selected)));
  }
  document.querySelectorAll('[data-media-open]').forEach(button => button.addEventListener('click',() => {
    choose(button.dataset.mediaOpen);
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('media-dialog-open');
  }));
  dialog.querySelectorAll('[data-media-layout]').forEach(button => button.addEventListener('click',() => choose(button.dataset.mediaLayout)));
  dialog.querySelector('.media-dialog-close').addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => document.body.classList.remove('media-dialog-open'));
  dialog.addEventListener('click',event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
})();
