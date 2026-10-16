export function requestSettings(section: string) { window.dispatchEvent(new CustomEvent('webui:settings',{detail:section})) }
