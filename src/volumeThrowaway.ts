// THROWAWAY 3D volume spike — not wired into the app.
// Serves at http://localhost:5173/volume-throwaway.html
// Goal: see how the HCR134 stack (1024x1024, 7 z-planes, 4 channels,
// 15x anisotropy) looks as a vtk.js volume render. Delete when done.

import "@kitware/vtk.js/Rendering/Profiles/Volume";
import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import vtkImageMarchingCubes from "@kitware/vtk.js/Filters/General/ImageMarchingCubes";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";

const API = "http://localhost:8080/api/v1";
const ITEM = "6a05bf5804de280ec0a03247"; // HCR134 large_image item
const DATASET = "6a05bf5604de280ec0a03242"; // HCR134 dataset folder
const W = 1024;
const H = 1024;
const NZ = 7;
const SPACING_XY = 0.32572; // µm/pixel
const SPACING_Z = 5.0; // µm/plane  -> ~15x anisotropy

const CHANNELS = [
  { name: "DAPI", color: [0.1, 0.4, 1.0] },
  { name: "FITC", color: [0.1, 1.0, 0.2] },
  { name: "TRITC", color: [1.0, 0.3, 0.0] },
  { name: "Cy5", color: [1.0, 0.0, 0.9] },
];

const statusEl = document.getElementById("status")!;
const setStatus = (s: string) => (statusEl.textContent = s);

function getToken(): Promise<string> {
  // Throwaway: just mint a fresh token with the default localhost dev creds.
  // (The app's localStorage `nimbus.girderToken` is a {apiRoot, token} object
  // and is often expired, so we don't rely on it here.)
  return fetch(`${API}/user/authentication`, {
    headers: { Authorization: "Basic " + btoa("admin:password") },
  })
    .then((r) => r.json())
    .then((j) => j.authToken.token);
}

// Fetch one frame (a single channel at one z) as an 8-bit grayscale plane.
async function loadPlane(
  token: string,
  frame: number,
): Promise<Uint8Array> {
  const style = encodeURIComponent(JSON.stringify({ min: "min", max: "max" }));
  const url =
    `${API}/item/${ITEM}/tiles/zxy/0/0/0` +
    `?frame=${frame}&encoding=PNG&style=${style}&token=${token}`;
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = rgba[i * 4]; // R == grayscale
  return out;
}

interface ChannelVol {
  name: string;
  image: ReturnType<typeof vtkImageData.newInstance>;
  mapper: ReturnType<typeof vtkVolumeMapper.newInstance>;
  actor: ReturnType<typeof vtkVolume.newInstance>;
  maxVal: number;
}

function buildChannelVolume(
  planes: Uint8Array[],
  color: number[],
): ChannelVol {
  const vol = new Uint8Array(W * H * NZ);
  let maxVal = 0;
  for (let z = 0; z < NZ; z++) {
    vol.set(planes[z], z * W * H);
    for (let i = 0; i < planes[z].length; i++) {
      if (planes[z][i] > maxVal) maxVal = planes[z][i];
    }
  }

  const image = vtkImageData.newInstance();
  image.setDimensions(W, H, NZ);
  image.setSpacing(SPACING_XY, SPACING_XY, SPACING_Z);
  image.getPointData().setScalars(
    vtkDataArray.newInstance({ numberOfComponents: 1, values: vol }),
  );

  const mapper = vtkVolumeMapper.newInstance();
  mapper.setInputData(image);
  mapper.setBlendModeToMaximumIntensity();

  const ctf = vtkColorTransferFunction.newInstance();
  ctf.addRGBPoint(0, 0, 0, 0);
  ctf.addRGBPoint(255, color[0], color[1], color[2]);

  const ofun = vtkPiecewiseFunction.newInstance();
  ofun.addPoint(0, 0.0);
  ofun.addPoint(30, 0.0);
  ofun.addPoint(255, 0.85);

  const actor = vtkVolume.newInstance();
  actor.setMapper(mapper);
  const prop = actor.getProperty();
  prop.setRGBTransferFunction(0, ctf);
  prop.setScalarOpacity(0, ofun);
  prop.setInterpolationTypeToLinear();
  prop.setShade(false);

  return { name: "", image, mapper, actor, maxVal };
}

// Scanline-fill one polygon (pixel coords) into a z-plane of the mask volume.
function fillPolygon(
  mask: Uint8Array,
  zOffset: number,
  pts: { x: number; y: number }[],
) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const yi = pts[i].y;
      const yj = pts[j].y;
      if (yi > y !== yj > y) {
        xs.push(pts[i].x + ((y - yi) / (yj - yi)) * (pts[j].x - pts[i].x));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      const row = zOffset + y * W;
      for (let x = xa; x <= xb; x++) mask[row + x] = 255;
    }
  }
}

interface Annotation {
  shape: string;
  location: { Z: number };
  coordinates: { x: number; y: number }[];
}

// Fetch the dataset's polygon annotations, rasterize to a label volume, and
// extract an isosurface (marching cubes) -> 3D nuclei surfaces.
async function buildSegmentationSurface(token: string) {
  const anns: Annotation[] = await (
    await fetch(`${API}/upenn_annotation?datasetId=${DATASET}&limit=0&token=${token}`)
  ).json();

  const mask = new Uint8Array(W * H * NZ);
  let used = 0;
  for (const a of anns) {
    if (a.shape !== "polygon" || !a.coordinates?.length) continue;
    const z = a.location?.Z ?? 0;
    if (z < 0 || z >= NZ) continue;
    fillPolygon(mask, z * W * H, a.coordinates);
    used++;
  }

  const image = vtkImageData.newInstance();
  image.setDimensions(W, H, NZ);
  image.setSpacing(SPACING_XY, SPACING_XY, SPACING_Z);
  image.getPointData().setScalars(
    vtkDataArray.newInstance({ numberOfComponents: 1, values: mask }),
  );

  const mc = vtkImageMarchingCubes.newInstance({
    contourValue: 127,
    computeNormals: true,
  });
  mc.setInputData(image);

  const mapper = vtkMapper.newInstance({ scalarVisibility: false });
  mapper.setInputConnection(mc.getOutputPort());
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().setColor(1.0, 0.95, 0.3);
  actor.getProperty().setOpacity(0.55);

  return { actor, image, count: used };
}

async function main() {
  const t0 = performance.now();
  setStatus("authenticating…");
  const token = await getToken();

  setStatus("fetching 28 frames…");
  // frame = z * nChannels + c   (channels contiguous within each z)
  const NC = CHANNELS.length;
  const channelPlanes: Uint8Array[][] = await Promise.all(
    CHANNELS.map((_, c) =>
      Promise.all(
        Array.from({ length: NZ }, (_, z) => loadPlane(token, z * NC + c)),
      ),
    ),
  );

  setStatus("building volumes…");
  const grw = vtkGenericRenderWindow.newInstance({ background: [0, 0, 0] });
  grw.setContainer(document.getElementById("vtk") as HTMLElement);
  const renderer = grw.getRenderer();
  const renderWindow = grw.getRenderWindow();

  const channelsBox = document.getElementById("channels")!;
  const vols: ChannelVol[] = CHANNELS.map((ch, c) => {
    const cv = buildChannelVolume(channelPlanes[c], ch.color);
    cv.name = ch.name;
    renderer.addVolume(cv.actor);

    // visibility checkbox
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.onchange = () => {
      cv.actor.setVisibility(cb.checked);
      renderWindow.render();
    };
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = `rgb(${ch.color.map((x) => Math.round(x * 255)).join(",")})`;
    label.appendChild(cb);
    label.appendChild(sw);
    label.appendChild(
      document.createTextNode(`${ch.name}  (max ${cv.maxVal})`),
    );
    channelsBox.appendChild(label);
    return cv;
  });

  setStatus("rasterizing nuclei + marching cubes…");
  const seg = await buildSegmentationSurface(token);
  renderer.addActor(seg.actor);

  renderer.resetCamera();
  renderWindow.render();

  const dt = Math.round(performance.now() - t0);
  setStatus(
    `ready in ${dt} ms\n${NZ} planes × ${NC} ch @ ${W}×${H}\n` +
      `spacing ${SPACING_XY.toFixed(2)} / ${SPACING_XY.toFixed(2)} / ${SPACING_Z} µm\n` +
      `${seg.count} nuclei surfaces\ndrag to rotate`,
  );

  // ---- controls ----
  const mipBtn = document.getElementById("mip")!;
  const compBtn = document.getElementById("composite")!;
  const setBlend = (mip: boolean) => {
    vols.forEach((v) =>
      mip
        ? v.mapper.setBlendModeToMaximumIntensity()
        : v.mapper.setBlendModeToComposite(),
    );
    mipBtn.classList.toggle("active", mip);
    compBtn.classList.toggle("active", !mip);
    renderWindow.render();
  };
  mipBtn.onclick = () => setBlend(true);
  compBtn.onclick = () => setBlend(false);

  const anisoBtn = document.getElementById("aniso")!;
  const isoBtn = document.getElementById("iso")!;
  const setSpacingZ = (z: number, isAniso: boolean) => {
    vols.forEach((v) => v.image.setSpacing(SPACING_XY, SPACING_XY, z));
    seg.image.setSpacing(SPACING_XY, SPACING_XY, z);
    anisoBtn.classList.toggle("active", isAniso);
    isoBtn.classList.toggle("active", !isAniso);
    renderer.resetCamera();
    renderWindow.render();
  };
  anisoBtn.onclick = () => setSpacingZ(SPACING_Z, true);
  isoBtn.onclick = () => setSpacingZ(SPACING_XY, false);

  const segBtn = document.getElementById("seg")!;
  let segOn = true;
  segBtn.onclick = () => {
    segOn = !segOn;
    seg.actor.setVisibility(segOn);
    segBtn.classList.toggle("active", segOn);
    renderWindow.render();
  };

  const volBtn = document.getElementById("volBtn")!;
  let volOn = true;
  volBtn.onclick = () => {
    volOn = !volOn;
    vols.forEach((v) => v.actor.setVisibility(volOn));
    volBtn.classList.toggle("active", volOn);
    renderWindow.render();
  };

  document.getElementById("reset")!.onclick = () => {
    renderer.resetCamera();
    renderWindow.render();
  };

  window.addEventListener("resize", () => grw.resize());
  (window as any).__vol = { grw, vols, renderer, renderWindow };
}

main().catch((e) => {
  console.error(e);
  setStatus("ERROR: " + (e?.message ?? e) + "\n(see console)");
});
