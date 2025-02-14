import { TWorkerInterfaceType, TWorkerInterfaceValue } from "@/store/model";

export function getDefault(
  type: TWorkerInterfaceType,
  defaultValue?: TWorkerInterfaceValue,
) {
  if (defaultValue) {
    return defaultValue;
  }
  switch (type) {
    case "number":
      return 0.0;

    case "notes":
      return "";

    case "text":
      return "";

    case "tags":
      return [];

    case "layer":
      return null;

    case "select":
      return "";

    case "channel":
      return 0;

    case "channelCheckboxes":
      return {};

    case "checkbox":
      return false;
  }
}
