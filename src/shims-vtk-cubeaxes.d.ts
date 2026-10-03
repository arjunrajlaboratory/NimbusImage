// vtk.js ships CubeAxesActor without type declarations. It's a vtkActor
// subclass; the consumer casts newInstance() to a vtkActor intersection with
// the extra CubeAxes methods (see VolumeViewer.vue).
declare module "@kitware/vtk.js/Rendering/Core/CubeAxesActor" {
  const vtkCubeAxesActor: {
    newInstance(initialValues?: Record<string, unknown>): unknown;
  };
  export default vtkCubeAxesActor;
}
