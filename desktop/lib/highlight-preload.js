/* Tartarus Overlay: what the highlight window gets from the shell: the box
 * to draw ({ box: { x, y, w, h }, label }) in its own coordinates. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('TartarusHighlight', {
  onBox: (fn) => {
    if (typeof fn === 'function') ipcRenderer.on('box', (e, data) => fn(data));
  },
});
