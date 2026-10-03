import vtkPiecewiseFunction, {
  vtkPiecewiseFunction as VtkPiecewiseFunction,
} from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import vtkColorTransferFunction, {
  vtkColorTransferFunction as VtkColorTransferFunction,
} from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";

export interface IVolumeTransferFunctions {
  colorTransferFunction: VtkColorTransferFunction;
  opacityTransferFunction: VtkPiecewiseFunction;
}

function hexToRgb01(hexColor: string): [number, number, number] {
  const normalized = hexColor.replace("#", "");
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return [1, 1, 1];
  }
  return [
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
  ];
}

export function layerToVolumeTransferFunction(
  color: string,
): IVolumeTransferFunctions {
  const [red, green, blue] = hexToRgb01(color);

  const colorTransferFunction = vtkColorTransferFunction.newInstance();
  colorTransferFunction.addRGBPoint(0, 0, 0, 0);
  colorTransferFunction.addRGBPoint(255, red, green, blue);

  const opacityTransferFunction = vtkPiecewiseFunction.newInstance();
  opacityTransferFunction.addPoint(0, 0);
  opacityTransferFunction.addPoint(24, 0);
  opacityTransferFunction.addPoint(128, 0.12);
  opacityTransferFunction.addPoint(255, 0.38);

  return { colorTransferFunction, opacityTransferFunction };
}
