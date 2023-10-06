import { useState, useEffect } from 'react'
import { toolTips, useStore } from '../../useStore'
import { BinaryPart, Value, VariableDeclarator } from '../../lang/wasm'
import {
  getNodePathFromSourceRange,
  getNodeFromPath,
} from '../../lang/queryAst'
import { isSketchVariablesLinked } from '../../lang/std/sketchConstraints'
import {
  TransformInfo,
  transformSecondarySketchLinesTagFirst,
  getTransformInfos,
} from '../../lang/std/sketchcombos'
import { GetInfoModal, createInfoModal } from '../SetHorVertDistanceModal'
import { createVariableDeclaration } from '../../lang/modifyAst'
import { removeDoubleNegatives } from '../AvailableVarsHelpers'
import { updateCursors } from '../../lang/util'

const getModalInfo = createInfoModal(GetInfoModal)

export const SetAngleBetween = () => {
  const { guiMode, selectionRanges, ast, programMemory, updateAst, setCursor } =
    useStore((s) => ({
      guiMode: s.guiMode,
      ast: s.ast,
      updateAst: s.updateAst,
      selectionRanges: s.selectionRanges,
      programMemory: s.programMemory,
      setCursor: s.setCursor,
    }))
  const [enable, setEnable] = useState(false)
  const [transformInfos, setTransformInfos] = useState<TransformInfo[]>()
  useEffect(() => {
    if (!ast) return
    const paths = selectionRanges.codeBasedSelections.map(({ range }) =>
      getNodePathFromSourceRange(ast, range)
    )
    const nodes = paths.map(
      (pathToNode) => getNodeFromPath<Value>(ast, pathToNode).node
    )
    const varDecs = paths.map(
      (pathToNode) =>
        getNodeFromPath<VariableDeclarator>(
          ast,
          pathToNode,
          'VariableDeclarator'
        )?.node
    )
    const primaryLine = varDecs[0]
    const secondaryVarDecs = varDecs.slice(1)
    const isOthersLinkedToPrimary = secondaryVarDecs.every((secondary) =>
      isSketchVariablesLinked(secondary, primaryLine, ast)
    )
    const isAllTooltips = nodes.every(
      (node) =>
        node?.type === 'CallExpression' &&
        toolTips.includes(node.callee.name as any)
    )

    const theTransforms = getTransformInfos(
      {
        ...selectionRanges,
        codeBasedSelections: selectionRanges.codeBasedSelections.slice(1),
      },
      ast,
      'setAngleBetween'
    )
    setTransformInfos(theTransforms)

    const _enableEqual =
      secondaryVarDecs.length === 1 &&
      isAllTooltips &&
      isOthersLinkedToPrimary &&
      theTransforms.every(Boolean)
    setEnable(_enableEqual)
  }, [guiMode, selectionRanges])
  if (guiMode.mode !== 'sketch') return null

  return (
    <button
      onClick={async () => {
        if (!(transformInfos && ast)) return
        const { modifiedAst, tagInfo, valueUsedInTransform, pathToNodeMap } =
          transformSecondarySketchLinesTagFirst({
            ast: JSON.parse(JSON.stringify(ast)),
            selectionRanges,
            transformInfos,
            programMemory,
          })
        const {
          segName,
          value,
          valueNode,
          variableName,
          newVariableInsertIndex,
          sign,
        } = await getModalInfo({
          segName: tagInfo?.tag,
          isSegNameEditable: !tagInfo?.isTagExisting,
          value: valueUsedInTransform,
          initialVariableName: 'angle',
        })
        if (
          segName === tagInfo?.tag &&
          value ===
            (valueUsedInTransform === undefined
              ? ''
              : String(Math.abs(valueUsedInTransform)))
        ) {
          updateAst(modifiedAst, true, {
            callBack: updateCursors(setCursor, selectionRanges, pathToNodeMap),
          })
        } else {
          const finalValue = removeDoubleNegatives(
            valueNode as BinaryPart,
            sign,
            variableName
          )
          // transform again but forcing certain values
          const { modifiedAst: _modifiedAst, pathToNodeMap } =
            transformSecondarySketchLinesTagFirst({
              ast,
              selectionRanges,
              transformInfos,
              programMemory,
              forceSegName: segName,
              forceValueUsedInTransform: finalValue,
            })
          if (variableName) {
            const newBody = [..._modifiedAst.body]
            newBody.splice(
              newVariableInsertIndex,
              0,
              createVariableDeclaration(variableName, valueNode)
            )
            _modifiedAst.body = newBody
          }
          updateAst(_modifiedAst, true, {
            callBack: updateCursors(setCursor, selectionRanges, pathToNodeMap),
          })
        }
      }}
      disabled={!enable}
      title="Set Angle Between"
    >
      Set Angle Between
    </button>
  )
}
