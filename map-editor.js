import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function startEditor({ THREE, renderer, map }) {
  const clone = value => structuredClone(value);
  const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const base64 = data => { let s = ''; for (let i = 0; i < data.length; i += 8192) s += String.fromCharCode(...data.subarray(i, i + 8192)); return btoa(s); };
  const point = (view, offset) => [0, 1, 2].map(a => view.getInt16(offset + a * 2, true) / map.quant + map.origin[a]);
  const xyz = p => [p[0], p[2], -p[1]];
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xbdd5ec);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x718096, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(-1000, 3000, 1000); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 1, 20000);
  const canvas = renderer.domElement;
  renderer.shadowMap.enabled = false;
  const controls = new OrbitControls(camera, canvas);
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.minDistance = 12; controls.maxDistance = 9000;
  const pieces = [], selected = new Set(), history = [], future = [];
  let edits = {}, saved = '', draftAvailable = false;
  const hullBytes = bytes(map.hulls), hv = new DataView(hullBytes.buffer);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
  const glass = material.clone(); glass.transparent = true; glass.opacity = .45; glass.depthWrite = false;
  const addPiece = piece => {
    const positions = [], colors = [];
    for (const face of piece.faces) for (let k = 1; k < face.ids.length - 1; k++) {
      const color = new THREE.Color(`rgb(${map.palette[face.palette].rgb.join(',')})`);
      for (const id of [face.ids[0], face.ids[k], face.ids[k + 1]]) { positions.push(...xyz(piece.vertices[id])); colors.push(color.r, color.g, color.b); }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, piece.faces.every(f => map.palette[f.palette].glass) ? glass : material);
    piece.mesh = mesh; piece.originalColors = colors; mesh.userData.piece = piece; scene.add(mesh); pieces.push(piece);
  };
  for (let id = 0, o = 0; id < map.hullCount; id++) {
    const start = o, nv = hullBytes[o++], nf = hullBytes[o++], palette = hv.getUint16(o, true); o += 2;
    const vertices = []; for (let i = 0; i < nv; i++, o += 6) vertices.push(point(hv, o));
    const faces = []; for (let i = 0; i < nf; i++) { const n = hullBytes[o++]; faces.push({ ids: Array.from(hullBytes.subarray(o, o + n)), palette }); o += n; }
    addPiece({ id: `h${id}`, type: 'Block', vertices, faces, raw: hullBytes.slice(start, o) });
  }
  map.meshes.forEach((m, mi) => {
    if (!['solid', 'ladder'].includes(m.kind)) return;
    const vb = bytes(m.verts), tb = bytes(m.tris), vv = new DataView(vb.buffer), tv = new DataView(tb.buffer);
    const vertices = Array.from({ length: m.nv }, (_, i) => point(vv, i * 6));
    const parents = vertices.map((_, i) => i), root = i => parents[i] === i ? i : parents[i] = root(parents[i]);
    const same = new Map(); vertices.forEach((v, i) => { const key = v.join(','); if (same.has(key)) parents[root(i)] = root(same.get(key)); else same.set(key, i); });
    const triangles = Array.from({ length: m.nt }, (_, i) => ({ ids: [0, 1, 2].map(a => tv.getUint16(i * 8 + a * 2, true)), palette: tv.getUint16(i * 8 + 6, true), index: i }));
    triangles.forEach(({ ids: [a, b, c] }) => { parents[root(a)] = root(b); parents[root(b)] = root(c); });
    const groups = new Map(); triangles.forEach(t => { const key = root(t.ids[0]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(t); });
    let group = 0;
    for (const faces of groups.values()) {
      const ids = [...new Set(faces.flatMap(f => f.ids))], lookup = new Map(ids.map((id, i) => [id, i]));
      addPiece({ id: `m${mi}g${group++}`, type: m.kind === 'ladder' ? 'Protected ladder' : 'Connected mesh', locked: m.kind === 'ladder', mi, vertexIds: ids, vertices: ids.map(i => vertices[i]), faces: faces.map(f => ({ ...f, ids: f.ids.map(i => lookup.get(i)) })) });
    }
  });
  const markers = new THREE.Group(); scene.add(markers);
  for (const t of map.triggers) {
    const min = new THREE.Vector3(...xyz([t.box[0][0], t.box[1][1], t.box[0][2]])), max = new THREE.Vector3(...xyz([t.box[1][0], t.box[0][1], t.box[1][2]]));
    markers.add(new THREE.Box3Helper(new THREE.Box3(min, max), t.actions.some(a => a[0] === 'fall') ? 0xf87171 : 0x4ade80));
  }
  markers.visible = false;
  const outlines = new THREE.Group(); scene.add(outlines);
  document.querySelectorAll('#menu,#hud,#fade,#replayBar,#console').forEach(el => el.style.display = 'none');
  const style = document.createElement('style'); style.textContent = `#mapEditor{position:fixed;z-index:100;left:16px;top:16px;width:290px;max-height:calc(100vh - 32px);overflow:auto;padding:18px;background:#101923f5;color:#e9f1f8;border:1px solid #42536a;border-radius:12px;font:14px/1.45 system-ui;box-shadow:0 8px 30px #0004}#mapEditor h2{font-size:19px;margin:0 0 6px}#mapEditor p{margin:8px 0;color:#b9c8d8}#mapEditor button,#mapEditor select,#mapEditor input{font:inherit;border:1px solid #506078;border-radius:6px;padding:7px;background:#213248;color:#fff;box-sizing:border-box;min-width:0}#mapEditor button{cursor:pointer}#mapEditor button:disabled{opacity:.4;cursor:default}#mapEditor .row{display:flex;gap:6px;margin:8px 0}#mapEditor .row>*{flex:1}#mapEditor label{display:block;margin-top:8px}#mapEditor input[type=number]{width:100%}#mapEditor input[type=color]{width:100%;height:36px;padding:2px}#mapEditor .primary{background:#206bd0}#mapEditor small{display:block;color:#a8b8cb;margin:5px 0}#mapEditor #ed-status{color:#b6dcff;overflow-wrap:anywhere}#mapEditor hr{border:0;border-top:1px solid #3a4b60;margin:14px 0}`;
  document.head.append(style);
  const panel = document.createElement('aside'); panel.id = 'mapEditor';
  panel.innerHTML = `<h2>Map editor</h2><p>Click a part. Shift-click to select more.</p><small>Right-drag: orbit · Middle-drag: pan<br>Scroll: zoom · F: focus selected</small><div class="row"><button id="ed-home">Overview</button><button id="ed-focus">Focus</button></div><label>Go to checkpoint<select id="ed-cp" style="width:100%"><option value="">Choose…</option>${Object.keys(map.teleports).map(n => `<option value="${n}">${n}</option>`).join('')}</select></label><label><input id="ed-zones" type="checkbox"> Show protected trigger zones</label><hr><p id="ed-selection">No part selected</p><small>Connected meshes may contain a whole wall or building.</small><label>Move by (Source units; Z is up)</label><div class="row">${['X', 'Y', 'Z'].map(a => `<label>${a}<input id="ed-${a}" aria-label="Move ${a}" type="number" step="${1 / map.quant}" value="0"></label>`).join('')}</div><button id="ed-move">Move selected</button><label>Selected part color<input id="ed-color" aria-label="Part color" type="color" value="#7db1cf"></label><div class="row"><button id="ed-paint">Apply color</button><button id="ed-delete">Delete</button></div><div class="row"><button id="ed-undo">Undo</button><button id="ed-redo">Redo</button></div><hr><p id="ed-status" role="status">Original map. Changes are local only.</p><div class="row"><button id="ed-export" class="primary">Export map</button><button id="ed-restore">Restore draft</button></div><button id="ed-reset">Discard edits</button><p>To publish: replace <b>maps/kz_hub.json</b> in your repo with the export, then push to <b>kz</b>.</p><small>Ladders, checkpoints, teleports and invisible boundary collision are protected. Export does not publish anything. Deleting a wall does not delete separate boundary clips.</small>`;
  document.body.append(panel);
  const $ = id => panel.querySelector(`#ed-${id}`), status = text => $('status').textContent = text;
  let hash = 2166136261; for (const c of JSON.stringify(map)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  const draftKey = `kz-editor-${hash >>> 0}`;
  try { saved = localStorage.getItem(draftKey) || ''; draftAvailable = !!saved; } catch {}
  const current = id => edits[id] || { offset: [0, 0, 0], color: null, deleted: false };
  const update = () => {
    for (const p of pieces) {
      const e = current(p.id); p.mesh.visible = !e.deleted; p.mesh.position.set(...xyz(e.offset));
      const attr = p.mesh.geometry.getAttribute('color');
      if (e.color) { const c = new THREE.Color(e.color); for (let i = 0; i < attr.count; i++) attr.setXYZ(i, c.r, c.g, c.b); } else attr.array.set(p.originalColors);
      attr.needsUpdate = true;
    }
    for (const child of [...outlines.children]) { child.geometry.dispose(); child.material.dispose(); outlines.remove(child); }
    scene.updateMatrixWorld(true);
    for (const p of selected) if (p.mesh.visible) outlines.add(new THREE.Box3Helper(new THREE.Box3().setFromObject(p.mesh), 0x55ffbe));
    const editable = [...selected].filter(p => !p.locked && !current(p.id).deleted);
    $('selection').textContent = selected.size === 1 ? `${[...selected][0].type} ${[...selected][0].id}` : `${selected.size} parts selected`;
    for (const id of ['move', 'paint', 'delete']) $(id).disabled = !editable.length;
    $('undo').disabled = !history.length; $('redo').disabled = !future.length; $('restore').disabled = !draftAvailable;
    renderer.render(scene, camera);
  };
  const persist = () => { try { localStorage.setItem(draftKey, JSON.stringify(edits)); status('Draft saved in this browser. Export when ready.'); } catch { status('Browser storage is full. Export now to keep your changes.'); } };
  const change = fn => {
    const before = clone(edits);
    try { fn(); } catch (e) { edits = before; status(e.message); return; }
    if (JSON.stringify(before) === JSON.stringify(edits)) return;
    history.push(before); if (history.length > 60) history.shift(); future.length = 0; draftAvailable = false; persist(); update();
  };
  const apply = fn => change(() => { for (const p of selected) if (!p.locked && !current(p.id).deleted) { const e = clone(current(p.id)); fn(e, p); edits[p.id] = e; } });
  const focus = box => { const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length(); controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(1, .8, 1).normalize().multiplyScalar(Math.max(150, size))); controls.update(); };
  const overview = () => { controls.target.set(-2650, 460, 2250); camera.position.set(-800, 2100, 4200); controls.update(); };
  $('home').onclick = overview;
  $('focus').onclick = () => { const box = new THREE.Box3(); for (const p of selected) if (p.mesh.visible) box.expandByObject(p.mesh); if (!box.isEmpty()) focus(box); };
  $('cp').onchange = () => { const t = map.teleports[$('cp').value]; if (t) { const v = new THREE.Vector3(...xyz(t.pos)); focus(new THREE.Box3(v.clone().addScalar(-100), v.clone().addScalar(100))); } };
  $('zones').onchange = () => { markers.visible = $('zones').checked; renderer.render(scene, camera); };
  $('move').onclick = () => apply((e, p) => {
    const delta = ['X', 'Y', 'Z'].map(a => Number($(a).value)); if (delta.some(n => !Number.isFinite(n))) throw Error('Enter a valid number for each axis.');
    e.offset = e.offset.map((n, a) => Math.round((n + delta[a]) * map.quant) / map.quant);
    if (p.vertices.some(v => v.some((n, a) => { const q = Math.round((n + e.offset[a] - map.origin[a]) * map.quant); return q < -32768 || q > 32767; }))) throw Error('That move exceeds the map coordinate range. Try a smaller move.');
  });
  $('paint').onclick = () => apply(e => { e.color = $('color').value; });
  $('delete').onclick = () => { const large = [...selected].some(p => !p.locked && p.mi !== undefined && p.faces.length > 100); if (large && !confirm('This selection includes a large connected mesh, possibly a whole building. Delete it? Undo will restore it.')) return; apply(e => { e.deleted = true; }); };
  $('undo').onclick = () => { if (history.length) { future.push(clone(edits)); edits = history.pop(); persist(); update(); } };
  $('redo').onclick = () => { if (future.length) { history.push(clone(edits)); edits = future.pop(); persist(); update(); } };
  $('restore').onclick = () => { if (draftAvailable) { try { const restored = JSON.parse(saved); if (Object.entries(restored).some(([id, e]) => !pieces.some(p => p.id === id && !p.locked) || !Array.isArray(e.offset) || e.offset.length !== 3 || e.offset.some(n => !Number.isFinite(n)) || (e.color !== null && !/^#[0-9a-f]{6}$/i.test(e.color)) || typeof e.deleted !== 'boolean')) throw Error(); change(() => { edits = restored; }); } catch { status('Could not restore this draft. The original map is unchanged.'); } } };
  $('reset').onclick = () => { if (confirm('Discard all local edits? You can undo this until you close the editor.')) change(() => { edits = {}; }); };
  const exportMap = () => {
    const result = clone(map), hulls = [];
    const paletteIndex = (p, color) => { if (!color) return p; const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)), glass = map.palette[p].glass; let index = result.palette.findIndex(p => p.glass === glass && p.rgb.every((v, i) => v === rgb[i])); if (index < 0) { index = result.palette.length; result.palette.push({ rgb, glass }); } return index; };
    for (const p of pieces.filter(p => p.raw)) {
      const e = current(p.id); if (e.deleted) continue;
      const data = p.raw.slice(), view = new DataView(data.buffer); view.setUint16(2, paletteIndex(p.faces[0].palette, e.color), true);
      p.vertices.forEach((v, i) => v.forEach((n, a) => view.setInt16(4 + i * 6 + a * 2, Math.round((n + e.offset[a] - map.origin[a]) * map.quant), true))); hulls.push(data);
    }
    const joined = new Uint8Array(hulls.reduce((s, b) => s + b.length, 0)); let offset = 0; hulls.forEach(b => { joined.set(b, offset); offset += b.length; }); result.hulls = base64(joined); result.hullCount = hulls.length;
    result.meshes = map.meshes.map((m, mi) => {
      const groups = pieces.filter(p => p.mi === mi); if (!groups.some(p => edits[p.id])) return clone(m);
      const verts = [], tris = [];
      for (const p of groups) {
        const e = current(p.id); if (e.deleted) continue; const base = verts.length;
        p.vertices.forEach(v => verts.push(v.map((n, a) => Math.round((n + e.offset[a] - map.origin[a]) * map.quant))));
        p.faces.forEach(f => tris.push([...f.ids.map(i => i + base), paletteIndex(f.palette, e.color)]));
      }
      const vb = new Uint8Array(verts.length * 6), tb = new Uint8Array(tris.length * 8), vv = new DataView(vb.buffer), tv = new DataView(tb.buffer);
      verts.forEach((v, i) => v.forEach((n, a) => vv.setInt16(i * 6 + a * 2, n, true))); tris.forEach((v, i) => v.forEach((n, a) => tv.setUint16(i * 8 + a * 2, n, true)));
      return { ...m, nv: verts.length, nt: tris.length, verts: base64(vb), tris: base64(tb) };
    });
    return result;
  };
  $('export').onclick = () => { const blob = new Blob([JSON.stringify(exportMap()) + '\n'], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'kz_hub.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status('Export downloaded. Your live map has not changed.'); };
  const raycaster = new THREE.Raycaster();
  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect(); raycaster.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObjects(pieces.filter(p => p.mesh.visible).map(p => p.mesh), false)[0];
    if (!e.shiftKey) selected.clear(); if (hit) { const p = hit.object.userData.piece; if (e.shiftKey && selected.has(p)) selected.delete(p); else selected.add(p); const rgb = map.palette[p.faces[0].palette].rgb; $('color').value = current(p.id).color || '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''); } update();
  }, true);
  canvas.addEventListener('click', e => e.stopImmediatePropagation(), true);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('keydown', e => { if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return; if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); $(e.shiftKey ? 'redo' : 'undo').click(); } else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); $('delete').click(); } else if (e.code === 'KeyF') $('focus').click(); });
  addEventListener('beforeunload', e => { if (Object.keys(edits).length) { e.preventDefault(); e.returnValue = ''; } });
  controls.addEventListener('change', () => renderer.render(scene, camera));
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); renderer.render(scene, camera); });
  overview(); update(); if (draftAvailable) status('A saved draft is available. Restore it or start from the original.');
}
