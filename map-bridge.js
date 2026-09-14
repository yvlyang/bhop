export function createMapBridge({ THREE, map, pieces, current, sourceHash }) {
  const xyz = p => [p[0], p[2], -p[1]];
  const hex = p => '#' + map.palette[p.faces[0].palette].rgb.map(n => n.toString(16).padStart(2, '0')).join('');
  const triangleIds = p => p.faces.flatMap(f => f.ids.slice(1, -1).flatMap((id, i) => [f.ids[0], id, f.ids[i + 2]]));
  const validateVertices = (p, vertices) => {
    if (!Array.isArray(vertices) || vertices.length !== p.vertices.length || vertices.some(v => !Array.isArray(v) || v.length !== 3 || v.some((n, a) => !Number.isFinite(n) || Math.round((n - map.origin[a]) * map.quant) < -32768 || Math.round((n - map.origin[a]) * map.quant) > 32767))) throw Error(`${p.id}: coordinates are invalid or outside the map range.`);
  };
  const exportScene = () => {
    const scene = new THREE.Scene(); scene.name = 'kz_hub'; scene.background = new THREE.Color(0xbdd5ec);
    scene.userData.kzBridge = { version: 1, sourceHash, parts: {} };
    for (const p of pieces) {
      const e = current(p.id); if (e.deleted) continue;
      const vertices = e.vertices || p.vertices;
      const min = [0, 1, 2].map(a => Math.min(...vertices.map(v => v[a]))), max = [0, 1, 2].map(a => Math.max(...vertices.map(v => v[a])));
      const center = xyz(min.map((n, a) => (n + max[a]) / 2));
      const positions = triangleIds(p).flatMap(i => xyz(vertices[i]).map((n, a) => n - center[a]));
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
      const color = e.color || hex(p), transparent = p.faces.every(f => map.palette[f.palette].glass);
      const material = new THREE.MeshStandardMaterial({ color, roughness: 1, side: THREE.DoubleSide, transparent, opacity: transparent ? .45 : 1 });
      const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...center.map((n, a) => n + xyz(e.offset)[a]));
      mesh.name = `${p.locked ? 'LOCKED ' : ''}${p.type} ${p.id}`; mesh.userData.kzPart = p.id; scene.add(mesh);
      scene.userData.kzBridge.parts[p.id] = { vertices, center, color, editColor: e.color, opacity: material.opacity };
    }
    scene.add(new THREE.HemisphereLight(0xffffff, 0x718096, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(-1000, 3000, 1000); scene.add(sun);
    scene.updateMatrixWorld(true);
    const result = scene.toJSON();
    scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    return result;
  };
  const importScene = input => {
    const data = input.scene || input;
    if (!data?.object || !Array.isArray(data.geometries) || !Array.isArray(data.materials)) throw Error('Choose project.json saved by Three.js or a Scene JSON export, not GLB or a game map.');
    if (data.images?.length || data.textures?.length) throw Error('Textures are not supported. Keep the scene flat-colored.');
    const geometries = new Map(data.geometries.map(g => [g.uuid, g])), materials = new Map(data.materials.map(m => [m.uuid, m]));
    const known = new Map(pieces.map(p => [p.id, p])), found = new Map(); let metadata = null;
    const walk = (node, parent, visible) => {
      if (node.userData?.kzBridge) { if (metadata) throw Error('More than one map found. Export one KZ scene.'); metadata = node.userData.kzBridge; }
      const matrix = new THREE.Matrix4();
      if (node.matrix) { if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || node.matrix.some(n => !Number.isFinite(n))) throw Error('Invalid object transform.'); matrix.fromArray(node.matrix); }
      else if (node.position || node.rotation || node.scale) throw Error('Export the scene with standard Three.js matrices.');
      matrix.premultiply(parent); visible = visible && node.visible !== false;
      if (node.type === 'Mesh') {
        const id = node.userData?.kzPart;
        if (!known.has(id)) throw Error('New or untagged meshes are not supported. Edit the exported parts without duplicating them.');
        if (found.has(id)) throw Error(`Duplicate part ${id}. Remove the duplicate before importing.`);
        found.set(id, { node, matrix, visible });
      }
      for (const child of node.children || []) walk(child, matrix, visible);
    };
    walk(data.object, new THREE.Matrix4(), true);
    if (metadata?.version !== 1 || metadata.sourceHash !== sourceHash || !metadata.parts) throw Error('This scene is not an export of the current map. Export a fresh scene from the KZ editor.');
    const edits = {};
    for (const p of pieces) {
      const item = found.get(p.id), base = metadata.parts[p.id];
      if (!item) { if (p.locked) throw Error('A protected ladder is missing. Restore it in Three.js before importing.'); edits[p.id] = { offset: [0, 0, 0], color: null, deleted: true }; continue; }
      if (!base) throw Error(`Missing original data for ${p.id}.`);
      validateVertices(p, base.vertices);
      if (!Array.isArray(base.center) || base.center.length !== 3 || base.center.some(n => !Number.isFinite(n))) throw Error('Invalid part origin.');
      const { node, matrix, visible } = item, geometry = geometries.get(node.geometry), material = materials.get(node.material);
      if (!visible) throw Error(`${p.id} is hidden. Delete parts instead of hiding them, or make it visible again.`);
      if (!geometry?.data?.attributes?.position || geometry.data.index || !material || Array.isArray(node.material)) throw Error('Changing geometry or using multiple materials is not supported.');
      const expected = triangleIds(p).flatMap(i => xyz(base.vertices[i]).map((n, a) => Math.fround(n - base.center[a]))), actual = geometry.data.attributes.position.array;
      if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((n, i) => n !== expected[i])) throw Error(`${p.id}: geometry was modified. Use move, rotate, and scale controls, not geometry editing.`);
      if (!Number.isFinite(matrix.determinant()) || matrix.determinant() <= 1e-9 || matrix.elements[3] !== 0 || matrix.elements[7] !== 0 || matrix.elements[11] !== 0 || matrix.elements[15] !== 1) throw Error('Mirrored, flattened, or invalid transforms are not supported.');
      if (!Number.isInteger(material.color) || material.color < 0 || material.color > 0xffffff || (material.opacity ?? 1) !== base.opacity) throw Error('Only the material color can change; keep opacity unchanged.');
      const color = '#' + material.color.toString(16).padStart(6, '0');
      const vertices = base.vertices.map(v => { const q = new THREE.Vector3(...xyz(v).map((n, a) => n - base.center[a])).applyMatrix4(matrix); return [q.x, -q.z, q.y].map((n, a) => Math.round((n - map.origin[a]) * map.quant) / map.quant + map.origin[a]); });
      validateVertices(p, vertices);
      if (new Set(vertices.map(v => v.join(','))).size !== new Set(p.vertices.map(v => v.join(','))).size) throw Error(`${p.id}: scaling collapsed vertices at the map's precision. Use a larger scale.`);
      const changed = vertices.some((v, i) => v.some((n, a) => n !== p.vertices[i][a]));
      const editColor = color.toLowerCase() === base.color?.toLowerCase() ? base.editColor : color;
      if (editColor !== null && !/^#[0-9a-f]{6}$/i.test(editColor)) throw Error('Invalid saved part color.');
      if (p.locked) { if (changed || color.toLowerCase() !== hex(p)) throw Error('Ladders are protected. Undo their movement or color changes before importing.'); continue; }
      if (changed || editColor) edits[p.id] = { offset: [0, 0, 0], vertices, color: editColor, deleted: false };
    }
    return edits;
  };
  return { exportScene, importScene, validateVertices };
}
