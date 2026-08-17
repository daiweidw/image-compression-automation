import { contextBridge, webUtils } from "electron";

contextBridge.exposeInMainWorld("icaDesktop", {
  pathForFile: (file: File) => webUtils.getPathForFile(file)
});
