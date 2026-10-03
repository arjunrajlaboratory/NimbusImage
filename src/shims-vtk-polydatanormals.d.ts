// vtk.js ships PolyDataNormals without type declarations. Only the members
// used by VolumeViewer.vue are typed here.
declare module "@kitware/vtk.js/Filters/Core/PolyDataNormals" {
  import { vtkPolyData } from "@kitware/vtk.js/Common/DataModel/PolyData";

  export interface vtkPolyDataNormals {
    setInputData(polyData: vtkPolyData): void;
    getOutputData(): vtkPolyData;
    setComputePointNormals(value: boolean): boolean;
    setComputeCellNormals(value: boolean): boolean;
    delete(): void;
  }
  const vtkPolyDataNormalsFactory: {
    newInstance(initialValues?: Record<string, unknown>): vtkPolyDataNormals;
  };
  export default vtkPolyDataNormalsFactory;
}
