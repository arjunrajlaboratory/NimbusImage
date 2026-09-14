import { IAnnotationPropertyValues, TNestedValues } from "@/store/model";

// Using "===" won't work on list of string
export function arePathEquals(path: string[], otherPath: string[]): boolean {
  return (
    path.length === otherPath.length &&
    path.every((name, i) => name === otherPath[i])
  );
}

export function findIndexOfPath(path: string[], pathArray: string[][]): number {
  return pathArray.findIndex((otherPath) => arePathEquals(otherPath, path));
}

// Generate a unique string from a path
// A property path as a single string key, e.g. for Set/Map membership or a
// select's item value. NUL cannot appear in a path segment (isValidPropertyPath
// rejects "." and "$"; segments are user-facing names), so the round trip is
// exact — unlike "." which a display-name join would collide with.
export function serializePropertyPath(path: string[]): string {
  return path.join("\u0000");
}

export function deserializePropertyPath(key: string): string[] {
  return key.split("\u0000");
}

export function createPathStringFromPathArray(path: string[]): string {
  // . shouldn't be used in a subId (mongoDB restriction on field names)
  return path.join(".");
}

// The object given as argument is seen as a tree, and the keys along the tree form the path
// Return the location where the path leads, and null if the path is unknown
export function getValueFromObjectAndPath<T extends Exclude<any, object>>(
  values: TNestedValues<T>,
  path: string[],
): TNestedValues<T> | null {
  let currentItem = values;
  for (const name of path) {
    if (currentItem && typeof currentItem === "object" && name in currentItem) {
      // @ts-ignore: We from the check above that this is valid, as T can't be an object
      currentItem = currentItem[name];
    } else {
      return null;
    }
  }
  return currentItem;
}

// Specialised function for UI
// Get a string of the value rounded to to decimals or a dash if no value
export function getStringFromPropertiesAndPath(
  properties: IAnnotationPropertyValues[0],
  path: string[],
): string | null {
  const value = getValueFromObjectAndPath(properties, path);
  if (typeof value === "number") {
    const error = (stringValue: string) =>
      Math.abs(value - parseFloat(stringValue));
    // Use the representation that gives the minimum error
    return [value.toFixed(0), value.toFixed(2), value.toPrecision(3)].reduce(
      (currentBest: string, newValue: string) =>
        error(currentBest) > error(newValue) ? newValue : currentBest,
    );
  } else if (typeof value === "string") {
    return value;
  } else if (typeof value === "object") {
    // `value` is an object or null
    // There is no property value
    return null;
  } else {
    // `value` should be of type `never`
    const neverValue: never = value;
    return neverValue;
  }
}

export default {
  arePathEquals,
  findIndexOfPath,
  createPathStringFromPathArray,
  getValueFromObjectAndPath,
  getStringFromPropertiesAndPath,
};
