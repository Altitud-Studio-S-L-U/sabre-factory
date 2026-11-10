// Docker's containerd store exposes a config digest on the container and an
// index digest on image inspect. Only accept a verified matching platform image.
export function backupImageReference(container, image, selected) {
  const valid = (value) => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
  const manifest = container.ImageManifestDescriptor?.digest;
  if (!valid(image.Id) || !(container.Image === image.Id ||
    valid(manifest) && manifest === selected?.Descriptor?.digest)) {
    throw new Error('The local image does not match the running container. Retain and select its exact image.');
  }
  return image.Id;
}
