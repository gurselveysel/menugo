'use strict';
// Keep the restaurant host on its branch page and the platform host on its homepage.
if(location.hostname==='sariyerborekcisi.menugo.app'&&location.pathname==='/')location.replace('/bahcesehir'+location.search+location.hash);
