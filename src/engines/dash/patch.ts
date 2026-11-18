const mpdNs = 'urn:mpeg:dash:schema:mpd:2011';
const patchNs = 'urn:mpeg:dash:schema:mpd-patch:2020';
function xml(source: string) {
  if (source.length > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('Unsafe DASH patch XML');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (
    doc.getElementsByTagName('parsererror').length ||
    doc.getElementsByTagName('*').length > 150000
  )
    throw new Error('Invalid DASH patch XML');
  return doc;
}
function target(
  doc: Document,
  selector: string,
): { node: Element; attribute?: string } {
  if (selector.length > 2048 || !selector.startsWith('/MPD'))
    throw new Error('Unsupported DASH patch selector');
  const steps = selector.slice(1).split(/\/(?![^\[]*\])/);
  if (steps.length > 32) throw new Error('DASH patch selector depth');
  let nodes: Element[] = [doc.documentElement];
  let attribute: string | undefined;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (
      step.startsWith('@') &&
      i === steps.length - 1 &&
      /^@[A-Za-z_][\w.-]*$/.test(step)
    ) {
      attribute = step.slice(1);
      break;
    }
    const match =
      /^([A-Za-z_][\w.-]*)(?:\[(?:(\d+)|@([A-Za-z_][\w.-]*)=(['"])(.*?)\4)\])?$/.exec(
        step,
      );
    if (!match) throw new Error('Unsupported DASH patch predicate');
    nodes = nodes.flatMap((parent) => {
      let candidates = (
        i === 0 ? [parent] : Array.from(parent.children)
      ).filter((e) => e.namespaceURI === mpdNs && e.localName === match[1]);
      if (match[2])
        candidates = candidates.slice(Number(match[2]) - 1, Number(match[2]));
      if (match[3])
        candidates = candidates.filter(
          (e) => e.getAttribute(match[3]) === match[5],
        );
      return candidates;
    });
  }
  if (nodes.length !== 1) throw new Error('DASH patch selector is not unique');
  return { node: nodes[0], attribute };
}
function importElement(doc: Document, element: Element): Element {
  const node = doc.createElementNS(
    element.namespaceURI === patchNs ? mpdNs : element.namespaceURI,
    element.localName,
  );
  for (const a of Array.from(element.attributes))
    if (a.name !== 'xmlns')
      node.setAttributeNS(a.namespaceURI, a.name, a.value);
  for (const child of Array.from(element.childNodes))
    node.append(
      child.nodeType === 1
        ? importElement(doc, child as Element)
        : doc.importNode(child, true),
    );
  return node;
}
/** Apply a bounded, transactional MPD Patch. Unsupported selectors trigger full-MPD fallback. */
export function applyMpdPatch(original: string, update: string): string {
  const doc = xml(original),
    patch = xml(update).documentElement,
    root = doc.documentElement;
  const previous = root.getAttribute('publishTime'),
    next = patch.getAttribute('publishTime');
  if (
    patch.namespaceURI !== patchNs ||
    patch.localName !== 'Patch' ||
    !root.getAttribute('id') ||
    patch.getAttribute('mpdId') !== root.getAttribute('id') ||
    !previous ||
    Date.parse(patch.getAttribute('originalPublishTime') ?? '') !==
      Date.parse(previous) ||
    !next ||
    !(Date.parse(next) > Date.parse(previous))
  )
    throw new Error('DASH patch identity/publication mismatch');
  if (patch.children.length > 10000)
    throw new Error('DASH patch operation limit');
  for (const operation of Array.from(patch.children)) {
    if (
      operation.namespaceURI !== patchNs ||
      !['add', 'remove', 'replace'].includes(operation.localName)
    )
      throw new Error('Unknown DASH patch operation');
    const { node, attribute } = target(
      doc,
      operation.getAttribute('sel') ?? '',
    );
    const kind = operation.localName;
    const addedAttribute = operation.getAttribute('type');
    if (attribute || addedAttribute) {
      const name = attribute ?? addedAttribute?.slice(1);
      if (
        !name ||
        (addedAttribute && !/^@[A-Za-z_][\w.-]*$/.test(addedAttribute)) ||
        operation.children.length
      )
        throw new Error('Invalid DASH patch attribute');
      if (kind !== 'add' && !node.hasAttribute(name))
        throw new Error('DASH patch attribute is absent');
      if (kind === 'add' && node.hasAttribute(name))
        throw new Error('DASH patch attribute already exists');
      if (kind === 'remove') node.removeAttribute(name);
      else node.setAttribute(name, operation.textContent ?? '');
      continue;
    }
    const children = Array.from(operation.children).map((e) =>
      importElement(doc, e),
    );
    if (kind === 'remove') {
      if (node === root || children.length)
        throw new Error('Invalid DASH patch remove');
      node.remove();
      continue;
    }
    if (!children.length)
      throw new Error('DASH patch requires replacement elements');
    if (kind === 'replace') {
      if (node === root)
        throw new Error('Root replacement requires a full MPD');
      node.replaceWith(...children);
      continue;
    }
    const position = operation.getAttribute('pos') ?? 'append';
    if (position === 'append') node.append(...children);
    else if (position === 'prepend') node.prepend(...children);
    else if (position === 'before' && node !== root) node.before(...children);
    else if (position === 'after' && node !== root) node.after(...children);
    else throw new Error('Invalid DASH patch insertion position');
  }
  if (Date.parse(root.getAttribute('publishTime') ?? '') !== Date.parse(next))
    throw new Error('DASH patch did not update publication time');
  const result = new XMLSerializer().serializeToString(doc);
  if (result.length > 4 * 1024 * 1024)
    throw new Error('Patched DASH MPD exceeds size limit');
  return result;
}
