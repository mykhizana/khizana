// Who owns the archive in this tab (the local owner on a device, the signed-in user in the cloud)
let ownerId = '00000000-0000-4000-8000-000000000001'
export const owner = () => ownerId
export const setOwner = (id: string) => {
  ownerId = id
}
