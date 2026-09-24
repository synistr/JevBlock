// Shared by popup and settings: numbers inside sentences are set in Geist Mono.
function setTextWithNumbers(node, text) {
  const parts = text.split(/(\$?\d[\d,.]*(?:\s?(?:ms|%))?)/);
  node.replaceChildren(
    ...parts.map((part, i) => {
      if (i % 2 === 0) return document.createTextNode(part);
      const num = document.createElement("span");
      num.className = "mono";
      num.textContent = part;
      return num;
    }),
  );
}
