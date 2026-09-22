'use strict';
const I = { home:'<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>', list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', plus:'<path d="M12 5v14M5 12h14"/>',
   inbox:'<path d="M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z"/>', pin:'<path d="M12 21s-7-6.2-7-11.5A7 7 0 0119 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
   tag:'<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>', star:'<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z"/>',
   percent:'<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>', help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>',
   text:'<path d="M4 6V4h16v2M12 4v16M9 20h6"/>', users:'<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6M16 4.5a3.5 3.5 0 010 7M22 20c0-3-2-5-5-5.7"/>',
   cog:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
   clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', menu:'<path d="M4 7h16M4 12h16M4 17h16"/>', search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>' };
module.exports = n => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (I[n]||'') + '</svg>';
