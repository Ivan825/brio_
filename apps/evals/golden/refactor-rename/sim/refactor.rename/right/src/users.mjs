const USERS = [{ id: 1, name: "Ada" }];
export function getUser(id) {
  return USERS.find((u) => u.id === id) ?? null;
}
/** @deprecated use getUser */
export const getUsr = getUser;
