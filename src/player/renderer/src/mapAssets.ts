const MAP_IMAGE_URLS: Record<string, string> = {
  de_mirage: new URL("./assets/maps/de_mirage.jpg", import.meta.url).href,
  de_nuke: new URL("./assets/maps/de_nuke.jpg", import.meta.url).href,
  de_ancient: new URL("./assets/maps/de_ancient.jpg", import.meta.url).href,
  de_inferno: new URL("./assets/maps/de_inferno.jpg", import.meta.url).href,
  de_dust2: new URL("./assets/maps/de_dust2.jpg", import.meta.url).href,
  de_cache: new URL("./assets/maps/de_cache.png", import.meta.url).href,
  de_overpass: new URL("./assets/maps/de_overpass.jpg", import.meta.url).href,
  de_vertigo: new URL("./assets/maps/de_vertigo.jpg", import.meta.url).href,
  de_train: new URL("./assets/maps/de_train.png", import.meta.url).href,
  de_anubis: new URL("./assets/maps/de_anubis.jpg", import.meta.url).href,
};

export function mapImageUrl(map: string): string | undefined {
  return MAP_IMAGE_URLS[map.toLowerCase()];
}

let preloaded = false;

export function preloadMapImages(): void {
  if (preloaded) return;
  preloaded = true;
  for (const url of Object.values(MAP_IMAGE_URLS)) {
    const image = new Image();
    image.src = url;
  }
}
