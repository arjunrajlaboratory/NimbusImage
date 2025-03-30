export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2") // convert camelCase to kebab
    .replace(/[\s_]+/g, "-") // convert spaces and underscores to hyphens
    .toLowerCase();
}

export function getTourStepId(id: string): string {
  return `${toKebabCase(id)}-tourstep`;
}

export function getTourTriggerId(id: string): string {
  return `${toKebabCase(id)}-tourtrigger`;
}

export function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}
