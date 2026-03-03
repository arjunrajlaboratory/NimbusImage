import fs from "fs";
import path from "path";

const files = [
  "src/App.test.ts",
  "src/layout/BreadCrumbs.test.ts",
  "src/layout/UserProfileSettings.test.ts",
  "src/components/CollectionItemRow.test.ts",
  "src/components/CollectionList.test.ts",
  "src/components/ZenodoImporter.test.ts",
  "src/views/Home.test.ts",
  "src/views/dataset/Dataset.test.ts",
  "src/views/dataset/DatasetInfo.test.ts",
  "src/views/dataset/ImportDataset.test.ts",
  "src/views/dataset/MultiSourceConfiguration.test.ts",
  "src/views/dataset/NewDataset.test.ts",
  "src/views/configuration/ConfigurationInfo.test.ts",
  "src/views/configuration/DuplicateImportConfiguration.test.ts",
  "src/views/configuration/ImportConfiguration.test.ts",
  "src/views/configuration/NewConfiguration.test.ts",
  "src/views/project/ProjectInfo.test.ts",
  "src/utils/useRouteMapper.test.ts",
];

for (const file of files) {
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) {
    console.log(`SKIP: ${file} not found`);
    continue;
  }
  let content = fs.readFileSync(fullPath, "utf-8");
  let changed = false;

  // 1. Add import for helpers if not present
  if (!content.includes("routeProvider") && !content.includes("routerProvider")) {
    // Find a good place to add the import - after the last import statement
    const importLines = content.split("\n");
    let lastImportIdx = -1;
    for (let i = 0; i < importLines.length; i++) {
      if (importLines[i].match(/^import\s/) || importLines[i].match(/^}\s*from\s/)) {
        lastImportIdx = i;
      }
    }
    if (lastImportIdx >= 0) {
      importLines.splice(lastImportIdx + 1, 0, 'import { routeProvider, routerProvider } from "@/test/helpers";');
      content = importLines.join("\n");
      changed = true;
    }
  }

  // Report what was found
  const routeMatches = content.match(/\$route/g);
  const routerMatches = content.match(/\$router/g);
  console.log(`${file}: $route x${routeMatches?.length || 0}, $router x${routerMatches?.length || 0}`);
  
  if (changed) {
    fs.writeFileSync(fullPath, content);
    console.log(`  -> Added import`);
  }
}
