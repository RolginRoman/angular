/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ApplicationRef} from '../application_ref';
import {ViewEncapsulation} from '../metadata';
import {Renderer2} from '../render';
import {collectNativeNodes, collectNativeNodesInLContainer} from '../render3/collect_native_nodes';
import {getComponentDef} from '../render3/definition';
import {CONTAINER_HEADER_OFFSET, LContainer} from '../render3/interfaces/container';
import {isTNodeShape, TNode, TNodeType} from '../render3/interfaces/node';
import {RElement} from '../render3/interfaces/renderer_dom';
import {hasI18n, isComponentHost, isLContainer, isProjectionTNode, isRootView} from '../render3/interfaces/type_checks';
import {CONTEXT, HEADER_OFFSET, HOST, LView, PARENT, RENDERER, TView, TVIEW, TViewType} from '../render3/interfaces/view';
import {unwrapLView, unwrapRNode} from '../render3/util/view_utils';
import {TransferState} from '../transfer_state';

import {unsupportedProjectionOfDomNodes} from './error_handling';
import {CONTAINERS, DISCONNECTED_NODES, ELEMENT_CONTAINERS, MULTIPLIER, NODES, NUM_ROOT_NODES, SerializedContainerView, SerializedView, TEMPLATE_ID, TEMPLATES} from './interfaces';
import {calcPathForNode} from './node_lookup_utils';
import {isInSkipHydrationBlock, SKIP_HYDRATION_ATTR_NAME} from './skip_hydration';
import {getLNodeForHydration, NGH_ATTR_NAME, NGH_DATA_KEY, TextNodeMarker} from './utils';

/**
 * A collection that tracks all serialized views (`ngh` DOM annotations)
 * to avoid duplication. An attempt to add a duplicate view results in the
 * collection returning the index of the previously collected serialized view.
 * This reduces the number of annotations needed for a given page.
 */
class SerializedViewCollection {
  private views: SerializedView[] = [];
  private indexByContent = new Map<string, number>();

  add(serializedView: SerializedView): number {
    const viewAsString = JSON.stringify(serializedView);
    if (!this.indexByContent.has(viewAsString)) {
      const index = this.views.length;
      this.views.push(serializedView);
      this.indexByContent.set(viewAsString, index);
      return index;
    }
    return this.indexByContent.get(viewAsString)!;
  }

  getAll(): SerializedView[] {
    return this.views;
  }
}

/**
 * Global counter that is used to generate a unique id for TViews
 * during the serialization process.
 */
let tViewSsrId = 0;

/**
 * Generates a unique id for a given TView and returns this id.
 * The id is also stored on this instance of a TView and reused in
 * subsequent calls.
 *
 * This id is needed to uniquely identify and pick up dehydrated views
 * at runtime.
 */
function getSsrId(tView: TView): string {
  if (!tView.ssrId) {
    tView.ssrId = `t${tViewSsrId++}`;
  }
  return tView.ssrId;
}

/**
 * Describes a context available during the serialization
 * process. The context is used to share and collect information
 * during the serialization.
 */
interface HydrationContext {
  serializedViewCollection: SerializedViewCollection;
  corruptedTextNodes: Map<HTMLElement, TextNodeMarker>;
}

/**
 * Computes the number of root nodes in a given view
 * (or child nodes in a given container if a tNode is provided).
 */
function calcNumRootNodes(tView: TView, lView: LView, tNode: TNode|null): number {
  const rootNodes: unknown[] = [];
  collectNativeNodes(tView, lView, tNode, rootNodes);
  return rootNodes.length;
}

/**
 * Computes the number of root nodes in all views in a given LContainer.
 */
function calcNumRootNodesInLContainer(lContainer: LContainer): number {
  const rootNodes: unknown[] = [];
  collectNativeNodesInLContainer(lContainer, rootNodes);
  return rootNodes.length;
}


/**
 * Annotates root level component's LView for hydration,
 * see `annotateHostElementForHydration` for additional information.
 */
function annotateComponentLViewForHydration(lView: LView, context: HydrationContext): number|null {
  const hostElement = lView[HOST];
  // Root elements might also be annotated with the `ngSkipHydration` attribute,
  // check if it's present before starting the serialization process.
  if (hostElement && !(hostElement as HTMLElement).hasAttribute(SKIP_HYDRATION_ATTR_NAME)) {
    return annotateHostElementForHydration(hostElement as HTMLElement, lView, context);
  }
  return null;
}

/**
 * Annotates root level LContainer for hydration. This happens when a root component
 * injects ViewContainerRef, thus making the component an anchor for a view container.
 * This function serializes the component itself as well as all views from the view
 * container.
 */
function annotateLContainerForHydration(lContainer: LContainer, context: HydrationContext) {
  const componentLView = unwrapLView(lContainer[HOST]) as LView<unknown>;

  // Serialize the root component itself.
  const componentLViewNghIndex = annotateComponentLViewForHydration(componentLView, context);

  const hostElement = unwrapRNode(componentLView[HOST]!) as HTMLElement;

  // Serialize all views within this view container.
  const rootLView = lContainer[PARENT];
  const rootLViewNghIndex = annotateHostElementForHydration(hostElement, rootLView, context);

  const renderer = componentLView[RENDERER] as Renderer2;

  // For cases when a root component also acts as an anchor node for a ViewContainerRef
  // (for example, when ViewContainerRef is injected in a root component), there is a need
  // to serialize information about the component itself, as well as an LContainer that
  // represents this ViewContainerRef. Effectively, we need to serialize 2 pieces of info:
  // (1) hydration info for the root component itself and (2) hydration info for the
  // ViewContainerRef instance (an LContainer). Each piece of information is included into
  // the hydration data (in the TransferState object) separately, thus we end up with 2 ids.
  // Since we only have 1 root element, we encode both bits of info into a single string:
  // ids are separated by the `|` char (e.g. `10|25`, where `10` is the ngh for a component view
  // and 25 is the `ngh` for a root view which holds LContainer).
  const finalIndex = `${componentLViewNghIndex}|${rootLViewNghIndex}`;
  renderer.setAttribute(hostElement, NGH_ATTR_NAME, finalIndex);
}

/**
 * Annotates all components bootstrapped in a given ApplicationRef
 * with info needed for hydration.
 *
 * @param appRef An instance of an ApplicationRef.
 * @param doc A reference to the current Document instance.
 */
export function annotateForHydration(appRef: ApplicationRef, doc: Document) {
  const serializedViewCollection = new SerializedViewCollection();
  const corruptedTextNodes = new Map<HTMLElement, TextNodeMarker>();
  const viewRefs = appRef._views;
  for (const viewRef of viewRefs) {
    const lNode = getLNodeForHydration(viewRef);

    // An `lView` might be `null` if a `ViewRef` represents
    // an embedded view (not a component view).
    if (lNode !== null) {
      const context: HydrationContext = {
        serializedViewCollection,
        corruptedTextNodes,
      };
      if (isLContainer(lNode)) {
        annotateLContainerForHydration(lNode, context);
      } else {
        annotateComponentLViewForHydration(lNode, context);
      }
      insertCorruptedTextNodeMarkers(corruptedTextNodes, doc);
    }
  }

  // Note: we *always* include hydration info key and a corresponding value
  // into the TransferState, even if the list of serialized views is empty.
  // This is needed as a signal to the client that the server part of the
  // hydration logic was setup and enabled correctly. Otherwise, if a client
  // hydration doesn't find a key in the transfer state - an error is produced.
  const serializedViews = serializedViewCollection.getAll();
  const transferState = appRef.injector.get(TransferState);
  transferState.set(NGH_DATA_KEY, serializedViews);
}

/**
 * Serializes the lContainer data into a list of SerializedView objects,
 * that represent views within this lContainer.
 *
 * @param lContainer the lContainer we are serializing
 * @param context the hydration context
 * @returns an array of the `SerializedView` objects
 */
function serializeLContainer(
    lContainer: LContainer, context: HydrationContext): SerializedContainerView[] {
  const views: SerializedContainerView[] = [];
  let lastViewAsString = '';

  for (let i = CONTAINER_HEADER_OFFSET; i < lContainer.length; i++) {
    let childLView = lContainer[i] as LView;

    let template: string;
    let numRootNodes: number;
    let serializedView: SerializedContainerView|undefined;

    if (isRootView(childLView)) {
      // If this is a root view, get an LView for the underlying component,
      // because it contains information about the view to serialize.
      childLView = childLView[HEADER_OFFSET];

      // If we have an LContainer at this position, this indicates that the
      // host element was used as a ViewContainerRef anchor (e.g. a `ViewContainerRef`
      // was injected within the component class). This case requires special handling.
      if (isLContainer(childLView)) {
        // Calculate the number of root nodes in all views in a given container
        // and increment by one to account for an anchor node itself, i.e. in this
        // scenario we'll have a layout that would look like this:
        // `<app-root /><#VIEW1><#VIEW2>...<!--container-->`
        // The `+1` is to capture the `<app-root />` element.
        numRootNodes = calcNumRootNodesInLContainer(childLView) + 1;

        annotateLContainerForHydration(childLView, context);

        const componentLView = unwrapLView(childLView[HOST]) as LView<unknown>;

        serializedView = {
          [TEMPLATE_ID]: componentLView[TVIEW].ssrId!,
          [NUM_ROOT_NODES]: numRootNodes,
        };
      }
    }

    if (!serializedView) {
      const childTView = childLView[TVIEW];

      if (childTView.type === TViewType.Component) {
        template = childTView.ssrId!;

        // This is a component view, thus it has only 1 root node: the component
        // host node itself (other nodes would be inside that host node).
        numRootNodes = 1;
      } else {
        template = getSsrId(childTView);
        numRootNodes = calcNumRootNodes(childTView, childLView, childTView.firstChild);
      }

      serializedView = {
        [TEMPLATE_ID]: template,
        [NUM_ROOT_NODES]: numRootNodes,
        ...serializeLView(lContainer[i] as LView, context),
      };
    }

    // Check if the previous view has the same shape (for example, it was
    // produced by the *ngFor), in which case bump the counter on the previous
    // view instead of including the same information again.
    const currentViewAsString = JSON.stringify(serializedView);
    if (views.length > 0 && currentViewAsString === lastViewAsString) {
      const previousView = views[views.length - 1];
      previousView[MULTIPLIER] ??= 1;
      previousView[MULTIPLIER]++;
    } else {
      // Record this view as most recently added.
      lastViewAsString = currentViewAsString;
      views.push(serializedView);
    }
  }
  return views;
}

/**
 * Helper function to produce a node path (which navigation steps runtime logic
 * needs to take to locate a node) and stores it in the `NODES` section of the
 * current serialized view.
 */
function appendSerializedNodePath(ngh: SerializedView, tNode: TNode, lView: LView) {
  const noOffsetIndex = tNode.index - HEADER_OFFSET;
  ngh[NODES] ??= {};
  ngh[NODES][noOffsetIndex] = calcPathForNode(tNode, lView);
}

/**
 * Helper function to append information about a disconnected node.
 * This info is needed at runtime to avoid DOM lookups for this element
 * and instead, the element would be created from scratch.
 */
function appendDisconnectedNodeIndex(ngh: SerializedView, tNode: TNode) {
  const noOffsetIndex = tNode.index - HEADER_OFFSET;
  ngh[DISCONNECTED_NODES] ??= [];
  if (!ngh[DISCONNECTED_NODES].includes(noOffsetIndex)) {
    ngh[DISCONNECTED_NODES].push(noOffsetIndex);
  }
}

/**
 * Serializes the lView data into a SerializedView object that will later be added
 * to the TransferState storage and referenced using the `ngh` attribute on a host
 * element.
 *
 * @param lView the lView we are serializing
 * @param context the hydration context
 * @returns the `SerializedView` object containing the data to be added to the host node
 */
function serializeLView(lView: LView, context: HydrationContext): SerializedView {
  const ngh: SerializedView = {};
  const tView = lView[TVIEW];
  // Iterate over DOM element references in an LView.
  for (let i = HEADER_OFFSET; i < tView.bindingStartIndex; i++) {
    const tNode = tView.data[i] as TNode;
    const noOffsetIndex = i - HEADER_OFFSET;
    // Skip processing of a given slot in the following cases:
    // - Local refs (e.g. <div #localRef>) take up an extra slot in LViews
    //   to store the same element. In this case, there is no information in
    //   a corresponding slot in TNode data structure.
    // - When a slot contains something other than a TNode. For example, there
    //   might be some metadata information about a defer block or a control flow block.
    if (!isTNodeShape(tNode)) {
      continue;
    }

    // Check if a native node that represents a given TNode is disconnected from the DOM tree.
    // Such nodes must be excluded from the hydration (since the hydration won't be able to
    // find them), so the TNode ids are collected and used at runtime to skip the hydration.
    //
    // This situation may happen during the content projection, when some nodes don't make it
    // into one of the content projection slots (for example, when there is no default
    // <ng-content /> slot in projector component's template).
    if (isDisconnectedNode(tNode, lView) && isContentProjectedNode(tNode)) {
      appendDisconnectedNodeIndex(ngh, tNode);
      continue;
    }
    if (Array.isArray(tNode.projection)) {
      for (const projectionHeadTNode of tNode.projection) {
        // We may have `null`s in slots with no projected content.
        if (!projectionHeadTNode) continue;

        if (!Array.isArray(projectionHeadTNode)) {
          // If we process re-projected content (i.e. `<ng-content>`
          // appears at projection location), skip annotations for this content
          // since all DOM nodes in this projection were handled while processing
          // a parent lView, which contains those nodes.
          if (!isProjectionTNode(projectionHeadTNode) &&
              !isInSkipHydrationBlock(projectionHeadTNode)) {
            if (isDisconnectedNode(projectionHeadTNode, lView)) {
              // Check whether this node is connected, since we may have a TNode
              // in the data structure as a projection segment head, but the
              // content projection slot might be disabled (e.g.
              // <ng-content *ngIf="false" />).
              appendDisconnectedNodeIndex(ngh, projectionHeadTNode);
            } else {
              appendSerializedNodePath(ngh, projectionHeadTNode, lView);
            }
          }
        } else {
          // If a value is an array, it means that we are processing a projection
          // where projectable nodes were passed in as DOM nodes (for example, when
          // calling `ViewContainerRef.createComponent(CmpA, {projectableNodes: [...]})`).
          //
          // In this scenario, nodes can come from anywhere (either created manually,
          // accessed via `document.querySelector`, etc) and may be in any state
          // (attached or detached from the DOM tree). As a result, we can not reliably
          // restore the state for such cases during hydration.

          throw unsupportedProjectionOfDomNodes(unwrapRNode(lView[i]));
        }
      }
    }
    if (isLContainer(lView[i])) {
      // Serialize information about a template.
      const embeddedTView = tNode.tView;
      if (embeddedTView !== null) {
        ngh[TEMPLATES] ??= {};
        ngh[TEMPLATES][noOffsetIndex] = getSsrId(embeddedTView);
      }

      // Serialize views within this LContainer.
      const hostNode = lView[i][HOST]!;  // host node of this container

      // LView[i][HOST] can be of 2 different types:
      // - either a DOM node
      // - or an array that represents an LView of a component
      if (Array.isArray(hostNode)) {
        // This is a component, serialize info about it.
        const targetNode = unwrapRNode(hostNode as LView) as RElement;
        if (!(targetNode as HTMLElement).hasAttribute(SKIP_HYDRATION_ATTR_NAME)) {
          annotateHostElementForHydration(targetNode, hostNode as LView, context);
        }
      }

      ngh[CONTAINERS] ??= {};
      ngh[CONTAINERS][noOffsetIndex] = serializeLContainer(lView[i], context);
    } else if (Array.isArray(lView[i])) {
      // This is a component, annotate the host node with an `ngh` attribute.
      const targetNode = unwrapRNode(lView[i][HOST]!);
      if (!(targetNode as HTMLElement).hasAttribute(SKIP_HYDRATION_ATTR_NAME)) {
        annotateHostElementForHydration(targetNode as RElement, lView[i], context);
      }
      // Include node path info to the annotation in case `tNode.next` (which hydration
      // relies upon by default) is different from the `tNode.projectionNext`. This helps
      // hydration runtime logic to find the right node.
      annotateNextNodePath(ngh, tNode, lView);
    } else {
      // <ng-container> case
      if (tNode.type & TNodeType.ElementContainer) {
        // An <ng-container> is represented by the number of
        // top-level nodes. This information is needed to skip over
        // those nodes to reach a corresponding anchor node (comment node).
        ngh[ELEMENT_CONTAINERS] ??= {};
        ngh[ELEMENT_CONTAINERS][noOffsetIndex] = calcNumRootNodes(tView, lView, tNode.child);
      } else if (tNode.type & TNodeType.Projection) {
        // Current TNode represents an `<ng-content>` slot, thus it has no
        // DOM elements associated with it, so the **next sibling** node would
        // not be able to find an anchor. In this case, use full path instead.
        let nextTNode = tNode.next;
        // Skip over all `<ng-content>` slots in a row.
        while (nextTNode !== null && (nextTNode.type & TNodeType.Projection)) {
          nextTNode = nextTNode.next;
        }
        if (nextTNode && !isInSkipHydrationBlock(nextTNode)) {
          // Handle a tNode after the `<ng-content>` slot.
          appendSerializedNodePath(ngh, nextTNode, lView);
        }
      } else {
        // Handle cases where text nodes can be lost after DOM serialization:
        //  1. When there is an *empty text node* in DOM: in this case, this
        //     node would not make it into the serialized string and as a result,
        //     this node wouldn't be created in a browser. This would result in
        //     a mismatch during the hydration, where the runtime logic would expect
        //     a text node to be present in live DOM, but no text node would exist.
        //     Example: `<span>{{ name }}</span>` when the `name` is an empty string.
        //     This would result in `<span></span>` string after serialization and
        //     in a browser only the `span` element would be created. To resolve that,
        //     an extra comment node is appended in place of an empty text node and
        //     that special comment node is replaced with an empty text node *before*
        //     hydration.
        //  2. When there are 2 consecutive text nodes present in the DOM.
        //     Example: `<div>Hello <ng-container *ngIf="true">world</ng-container></div>`.
        //     In this scenario, the live DOM would look like this:
        //       <div>#text('Hello ') #text('world') #comment('container')</div>
        //     Serialized string would look like this: `<div>Hello world<!--container--></div>`.
        //     The live DOM in a browser after that would be:
        //       <div>#text('Hello world') #comment('container')</div>
        //     Notice how 2 text nodes are now "merged" into one. This would cause hydration
        //     logic to fail, since it'd expect 2 text nodes being present, not one.
        //     To fix this, we insert a special comment node in between those text nodes, so
        //     serialized representation is: `<div>Hello <!--ngtns-->world<!--container--></div>`.
        //     This forces browser to create 2 text nodes separated by a comment node.
        //     Before running a hydration process, this special comment node is removed, so the
        //     live DOM has exactly the same state as it was before serialization.
        if (tNode.type & TNodeType.Text) {
          const rNode = unwrapRNode(lView[i]) as HTMLElement;
          // Collect this node as required special annotation only when its
          // contents is empty. Otherwise, such text node would be present on
          // the client after server-side rendering and no special handling needed.
          if (rNode.textContent === '') {
            context.corruptedTextNodes.set(rNode, TextNodeMarker.EmptyNode);
          } else if (rNode.nextSibling?.nodeType === Node.TEXT_NODE) {
            context.corruptedTextNodes.set(rNode, TextNodeMarker.Separator);
          }
        }

        // Include node path info to the annotation in case `tNode.next` (which hydration
        // relies upon by default) is different from the `tNode.projectionNext`. This helps
        // hydration runtime logic to find the right node.
        annotateNextNodePath(ngh, tNode, lView);
      }
    }
  }
  return ngh;
}

/**
 * If `tNode.projectionNext` is different from `tNode.next` - it means that
 * the next `tNode` after projection is different from the one in the original
 * template. In this case we need to serialize a path to that next node, so that
 * it can be found at the right location at runtime.
 */
function annotateNextNodePath(ngh: SerializedView, tNode: TNode, lView: LView<unknown>) {
  if (tNode.projectionNext && tNode.projectionNext !== tNode.next &&
      !isInSkipHydrationBlock(tNode.projectionNext)) {
    appendSerializedNodePath(ngh, tNode.projectionNext, lView);
  }
}

/**
 * Determines whether a component instance that is represented
 * by a given LView uses `ViewEncapsulation.ShadowDom`.
 */
function componentUsesShadowDomEncapsulation(lView: LView): boolean {
  const instance = lView[CONTEXT];
  return instance?.constructor ?
      getComponentDef(instance.constructor)?.encapsulation === ViewEncapsulation.ShadowDom :
      false;
}

/**
 * Annotates component host element for hydration:
 * - by either adding the `ngh` attribute and collecting hydration-related info
 *   for the serialization and transferring to the client
 * - or by adding the `ngSkipHydration` attribute in case Angular detects that
 *   component contents is not compatible with hydration.
 *
 * @param element The Host element to be annotated
 * @param lView The associated LView
 * @param context The hydration context
 * @returns An index of serialized view from the transfer state object
 *          or `null` when a given component can not be serialized.
 */
function annotateHostElementForHydration(
    element: RElement, lView: LView, context: HydrationContext): number|null {
  const renderer = lView[RENDERER];
  if (hasI18n(lView) || componentUsesShadowDomEncapsulation(lView)) {
    // Attach the skip hydration attribute if this component:
    // - either has i18n blocks, since hydrating such blocks is not yet supported
    // - or uses ShadowDom view encapsulation, since Domino doesn't support
    //   shadow DOM, so we can not guarantee that client and server representations
    //   would exactly match
    renderer.setAttribute(element, SKIP_HYDRATION_ATTR_NAME, '');
    return null;
  } else {
    const ngh = serializeLView(lView, context);
    const index = context.serializedViewCollection.add(ngh);
    renderer.setAttribute(element, NGH_ATTR_NAME, index.toString());
    return index;
  }
}

/**
 * Physically inserts the comment nodes to ensure empty text nodes and adjacent
 * text node separators are preserved after server serialization of the DOM.
 * These get swapped back for empty text nodes or separators once hydration happens
 * on the client.
 *
 * @param corruptedTextNodes The Map of text nodes to be replaced with comments
 * @param doc The document
 */
function insertCorruptedTextNodeMarkers(
    corruptedTextNodes: Map<HTMLElement, string>, doc: Document) {
  for (const [textNode, marker] of corruptedTextNodes) {
    textNode.after(doc.createComment(marker));
  }
}

/**
 * Detects whether a given TNode represents a node that
 * is being content projected.
 */
function isContentProjectedNode(tNode: TNode): boolean {
  let currentTNode = tNode;
  while (currentTNode != null) {
    // If we come across a component host node in parent nodes -
    // this TNode is in the content projection section.
    if (isComponentHost(currentTNode)) {
      return true;
    }
    currentTNode = currentTNode.parent as TNode;
  }
  return false;
}

/**
 * Check whether a given node exists, but is disconnected from the DOM.
 *
 * Note: we leverage the fact that we have this information available in the DOM emulation
 * layer (in Domino) for now. Longer-term solution should not rely on the DOM emulation and
 * only use internal data structures and state to compute this information.
 */
function isDisconnectedNode(tNode: TNode, lView: LView) {
  return !(tNode.type & TNodeType.Projection) && !!lView[tNode.index] &&
      !(unwrapRNode(lView[tNode.index]) as Node).isConnected;
}
