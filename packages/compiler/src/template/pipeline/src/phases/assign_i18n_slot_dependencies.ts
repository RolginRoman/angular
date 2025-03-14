/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ir from '../../ir';
import {CompilationJob} from '../compilation';

/**
 * Updates i18n expression ops to depend on the last slot in their owning i18n block.
 */
export function assignI18nSlotDependencies(job: CompilationJob) {
  const i18nLastSlotConsumers = new Map<ir.XrefId, ir.XrefId>();
  let lastSlotConsumer: ir.XrefId|null = null;
  let currentI18nOp: ir.I18nStartOp|null = null;

  for (const unit of job.units) {
    // Record the last consumed slot before each i18n end instruction.
    for (const op of unit.create) {
      if (ir.hasConsumesSlotTrait(op)) {
        lastSlotConsumer = op.xref;
      }

      switch (op.kind) {
        case ir.OpKind.I18nStart:
          currentI18nOp = op;
          break;
        case ir.OpKind.I18nEnd:
          i18nLastSlotConsumers.set(currentI18nOp!.xref, lastSlotConsumer!);
          currentI18nOp = null;
          break;
      }
    }

    // Assign i18n expressions to target the last slot in its owning block.
    for (const op of unit.update) {
      if (op.kind === ir.OpKind.I18nExpression) {
        op.target = i18nLastSlotConsumers.get(op.target)!;
      }
    }
  }
}
