export default [
  {
    name: "note_add",
    title: "Add a note",
    description: "Adds a note to the organization's notes",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    access: "write",
  },
  {
    name: "note_list",
    title: "List notes",
    description: "Lists the organization's notes and who is asking",
    inputSchema: { type: "object", properties: {} },
    access: "read",
  },
  {
    name: "note_dump",
    title: "Dump notes",
    description: "Answers more than an agent may receive",
    inputSchema: { type: "object", properties: {} },
    access: "read",
  },
]
