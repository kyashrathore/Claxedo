export const Binary = {
  search<T>(array: T[], id: string, compare: (item: T) => string): { found: boolean; index: number } {
    let left = 0
    let right = array.length - 1
    while (left <= right) {
      const middle = Math.floor((left + right) / 2)
      const middleId = compare(array[middle])
      if (middleId === id) return { found: true, index: middle }
      if (middleId < id) left = middle + 1
      else right = middle - 1
    }
    return { found: false, index: left }
  },
}
