//! Standard library patterns.

use anyhow::Result;
use derive_docs::stdlib;
use kittycad::types::ModelingCmd;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    errors::{KclError, KclErrorDetails},
    executor::{
        ExtrudeGroup, ExtrudeGroupSet, FunctionParam, Geometries, Geometry, MemoryItem, Point3d, ProgramReturn,
        SketchGroup, SketchGroupSet, SourceRange, UserVal,
    },
    std::{types::Uint, Args},
};

const CANNOT_USE_ZERO_VECTOR: &str =
    "The axis of the linear pattern cannot be the zero vector. Otherwise they will just duplicate in place.";

// /// How to change each element of a pattern.
// #[derive(Debug, Clone, Deserialize, Serialize, PartialEq, ts_rs::TS, JsonSchema)]
// #[ts(export)]
// #[serde(rename_all = "camelCase")]
// pub struct LinearTransform {
//     /// Translate the replica this far along each dimension.
//     /// Defaults to zero vector (i.e. same position as the original).
//     #[serde(default)]
//     pub translate: Option<Point3d>,
//     /// Scale the replica's size along each axis.
//     /// Defaults to (1, 1, 1) (i.e. the same size as the original).
//     #[serde(default)]
//     pub scale: Option<Point3d>,
//     /// Whether to replicate the original solid in this instance.
//     #[serde(default)]
//     pub replicate: Option<bool>,
// }

/// Data for a linear pattern on a 2D sketch.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, ts_rs::TS, JsonSchema)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinearPattern2dData {
    /// The number of repetitions. Must be greater than 0.
    /// This excludes the original entity. For example, if `repetitions` is 1,
    /// the original entity will be copied once.
    pub repetitions: Uint,
    /// The distance between each repetition. This can also be referred to as spacing.
    pub distance: f64,
    /// The axis of the pattern. This is a 2D vector.
    pub axis: [f64; 2],
}

/// Data for a linear pattern on a 3D model.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, ts_rs::TS, JsonSchema)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinearPattern3dData {
    /// The number of repetitions. Must be greater than 0.
    /// This excludes the original entity. For example, if `repetitions` is 1,
    /// the original entity will be copied once.
    pub repetitions: Uint,
    /// The distance between each repetition. This can also be referred to as spacing.
    pub distance: f64,
    /// The axis of the pattern.
    pub axis: [f64; 3],
}

pub enum LinearPattern {
    ThreeD(LinearPattern3dData),
    TwoD(LinearPattern2dData),
}

impl LinearPattern {
    pub fn axis(&self) -> [f64; 3] {
        match self {
            LinearPattern::TwoD(lp) => [lp.axis[0], lp.axis[1], 0.0],
            LinearPattern::ThreeD(lp) => lp.axis,
        }
    }

    pub fn repetitions(&self) -> u32 {
        match self {
            LinearPattern::TwoD(lp) => lp.repetitions.u32(),
            LinearPattern::ThreeD(lp) => lp.repetitions.u32(),
        }
    }

    pub fn distance(&self) -> f64 {
        match self {
            LinearPattern::TwoD(lp) => lp.distance,
            LinearPattern::ThreeD(lp) => lp.distance,
        }
    }
}

/// A linear pattern, either 2D or 3D.
/// Each element in the pattern repeats a particular piece of geometry.
/// The repetitions can be transformed by the `transform` parameter.
pub async fn pattern(args: Args) -> Result<MemoryItem, KclError> {
    let (num_repetitions, transform, entity_ids) = args.get_pattern_args()?;

    let sketch_groups = inner_pattern(
        num_repetitions,
        FunctionParam {
            inner: transform.func,
            fn_expr: transform.expr,
            meta: vec![args.source_range.into()],
            ctx: args.ctx.clone(),
            memory: args.memory.clone(),
        },
        entity_ids,
        &args,
    )
    .await?;
    Ok(MemoryItem::SketchGroups { value: sketch_groups })
}

/// A linear pattern on a 2D sketch.
pub async fn pattern_linear_2d(args: Args) -> Result<MemoryItem, KclError> {
    let (data, sketch_group_set): (LinearPattern2dData, SketchGroupSet) = args.get_data_and_sketch_group_set()?;

    if data.axis == [0.0, 0.0] {
        return Err(KclError::Semantic(KclErrorDetails {
            message: CANNOT_USE_ZERO_VECTOR.to_string(),
            source_ranges: vec![args.source_range],
        }));
    }

    let sketch_groups = inner_pattern_linear_2d(data, sketch_group_set, args).await?;
    Ok(MemoryItem::SketchGroups { value: sketch_groups })
}

/// A linear pattern on a 2D or 3D solid.
/// Each repetition of the pattern can be transformed (e.g. scaled, translated, hidden, etc).
///
/// ```no_run
/// The vase is 100 layers tall.
/// The 100 layers are replica of each other, with a slight transformation applied to each.
/// let vase = layer() |> pattern(100, transform, %)
/// // base radius
/// const r = 50
/// // layer height
/// const h = 10
/// // taper factor [0 - 1)
/// const t = 0.005
/// // Each layer is just a pretty thin cylinder.
/// fn layer = () => {
///   return startSketchOn("XY") // or some other plane idk
///     |> circle([0, 0], 1, %)
///     |> extrude(h, %)
/// // Change each replica's radius and shift it up the Z axis.
/// fn transform = (replicaId) => {
///   return {
///     translate: [0, 0, replicaId*10]
///     scale: r * abs(1 - (t * replicaId)) * (5 + cos(replicaId / 8))
///   }
/// }
/// ```
#[stdlib {
    name = "pattern",
}]
async fn inner_pattern<'a>(
    num_repetitions: u32,
    transform_function: FunctionParam<'a>,
    ids: Vec<Uuid>,
    args: &'a Args,
) -> Result<Vec<Box<SketchGroup>>, KclError> {
    // Build the vec of transforms, one for each repetition.
    let mut transforms = Vec::new();
    for i in 0..num_repetitions {
        // Call the transform fn for this repetition.
        let repetition_num = MemoryItem::UserVal(UserVal {
            value: serde_json::Value::Number(i.into()),
            meta: vec![args.source_range.into()],
        });
        let transform_fn_args = vec![repetition_num];
        let transform_fn_return = transform_function.call(transform_fn_args).await?;

        // Unpack the returned transform object.
        let transform_fn_return = transform_fn_return.ok_or_else(|| {
            KclError::Semantic(KclErrorDetails {
                message: "Transform function must return a value".to_string(),
                source_ranges: vec![args.source_range],
            })
        })?;
        let ProgramReturn::Value(transform_fn_return) = transform_fn_return else {
            return Err(KclError::Semantic(KclErrorDetails {
                message: "Transform function must return a value".to_string(),
                source_ranges: vec![args.source_range],
            }));
        };
        let MemoryItem::UserVal(transform) = transform_fn_return else {
            return Err(KclError::Semantic(KclErrorDetails {
                message: "Transform function must return a transform object".to_string(),
                source_ranges: vec![args.source_range],
            }));
        };

        // Apply defaults to the transform.
        let replicate = match transform.value.get("replicate") {
            Some(serde_json::Value::Bool(true)) => true,
            Some(serde_json::Value::Bool(false)) => false,
            Some(_) => {
                return Err(KclError::Semantic(KclErrorDetails {
                    message: "The 'replicate' key must be a bool".to_string(),
                    source_ranges: vec![args.source_range],
                }));
            }
            None => true,
        };
        let scale = match transform.value.get("scale") {
            Some(x) => array_to_point3d(x, vec![args.source_range])?,
            None => Point3d { x: 1.0, y: 1.0, z: 1.0 },
        };
        let translate = match transform.value.get("translate") {
            Some(x) => array_to_point3d(x, vec![args.source_range])?,
            None => Point3d { x: 0.0, y: 0.0, z: 0.0 },
        };
        let t = kittycad::types::LinearTransform {
            replicate,
            scale: Some(scale.into()),
            translate: Some(translate.into()),
        };
        transforms.push(dbg!(t));
    }
    for id in ids {
        // Call the pattern API endpoint.
        send_pattern_cmd(id, transforms.clone(), args).await?;
    }
    Ok(Vec::new())
}

/// A linear pattern on a 2D sketch.
///
/// ```no_run
/// const exampleSketch = startSketchOn('XZ')
///   |> circle([0, 0], 1, %)
///   |> patternLinear2d({
///        axis: [1, 0],
///        repetitions: 6,
///        distance: 4
///      }, %)
///
/// const example = extrude(1, exampleSketch)
/// ```
#[stdlib {
    name = "patternLinear2d",
}]
async fn inner_pattern_linear_2d(
    data: LinearPattern2dData,
    sketch_group_set: SketchGroupSet,
    args: Args,
) -> Result<Vec<Box<SketchGroup>>, KclError> {
    let starting_sketch_groups = match sketch_group_set {
        SketchGroupSet::SketchGroup(sketch_group) => vec![sketch_group],
        SketchGroupSet::SketchGroups(sketch_groups) => sketch_groups,
    };

    if args.ctx.is_mock {
        return Ok(starting_sketch_groups);
    }

    let mut sketch_groups = Vec::new();
    for sketch_group in starting_sketch_groups.iter() {
        let geometries = pattern_linear(
            LinearPattern::TwoD(data.clone()),
            Geometry::SketchGroup(sketch_group.clone()),
            args.clone(),
        )
        .await?;

        let Geometries::SketchGroups(new_sketch_groups) = geometries else {
            return Err(KclError::Semantic(KclErrorDetails {
                message: "Expected a vec of sketch groups".to_string(),
                source_ranges: vec![args.source_range],
            }));
        };

        sketch_groups.extend(new_sketch_groups);
    }

    Ok(sketch_groups)
}

/// A linear pattern on a 3D model.
pub async fn pattern_linear_3d(args: Args) -> Result<MemoryItem, KclError> {
    let (data, extrude_group_set): (LinearPattern3dData, ExtrudeGroupSet) = args.get_data_and_extrude_group_set()?;

    if data.axis == [0.0, 0.0, 0.0] {
        return Err(KclError::Semantic(KclErrorDetails {
            message:
                "The axis of the linear pattern cannot be the zero vector. Otherwise they will just duplicate in place."
                    .to_string(),
            source_ranges: vec![args.source_range],
        }));
    }

    let extrude_groups = inner_pattern_linear_3d(data, extrude_group_set, args).await?;
    Ok(MemoryItem::ExtrudeGroups { value: extrude_groups })
}

/// A linear pattern on a 3D model.
///
/// ```no_run
/// const exampleSketch = startSketchOn('XZ')
///   |> startProfileAt([0, 0], %)
///   |> line([0, 2], %)
///   |> line([3, 1], %)
///   |> line([0, -4], %)
///   |> close(%)
///
/// const example = extrude(1, exampleSketch)
///   |> patternLinear3d({
///        axis: [1, 0, 1],
///        repetitions: 6,
///       distance: 6
///     }, %)
/// ```
#[stdlib {
    name = "patternLinear3d",
}]
async fn inner_pattern_linear_3d(
    data: LinearPattern3dData,
    extrude_group_set: ExtrudeGroupSet,
    args: Args,
) -> Result<Vec<Box<ExtrudeGroup>>, KclError> {
    let starting_extrude_groups = match extrude_group_set {
        ExtrudeGroupSet::ExtrudeGroup(extrude_group) => vec![extrude_group],
        ExtrudeGroupSet::ExtrudeGroups(extrude_groups) => extrude_groups,
    };

    if args.ctx.is_mock {
        return Ok(starting_extrude_groups);
    }

    let mut extrude_groups = Vec::new();
    for extrude_group in starting_extrude_groups.iter() {
        let geometries = pattern_linear(
            LinearPattern::ThreeD(data.clone()),
            Geometry::ExtrudeGroup(extrude_group.clone()),
            args.clone(),
        )
        .await?;

        let Geometries::ExtrudeGroups(new_extrude_groups) = geometries else {
            return Err(KclError::Semantic(KclErrorDetails {
                message: "Expected a vec of extrude groups".to_string(),
                source_ranges: vec![args.source_range],
            }));
        };

        extrude_groups.extend(new_extrude_groups);
    }

    Ok(extrude_groups)
}

async fn send_pattern_cmd(
    entity_id: Uuid,
    transform: Vec<kittycad::types::LinearTransform>,
    args: &Args,
) -> Result<kittycad::types::EntityLinearPatternTransform, KclError> {
    let id = uuid::Uuid::new_v4();
    let resp = args
        .send_modeling_cmd(id, ModelingCmd::EntityLinearPatternTransform { entity_id, transform })
        .await?;
    let kittycad::types::OkWebSocketResponseData::Modeling {
        modeling_response: kittycad::types::OkModelingCmdResponse::EntityLinearPatternTransform { data: pattern_info },
    } = &resp
    else {
        return Err(KclError::Engine(KclErrorDetails {
            message: format!("EntityLinearPatternTransform response was not as expected: {:?}", resp),
            source_ranges: vec![args.source_range],
        }));
    };
    Ok(pattern_info.to_owned())
}

async fn pattern_linear(data: LinearPattern, geometry: Geometry, args: Args) -> Result<Geometries, KclError> {
    let id = uuid::Uuid::new_v4();

    let resp = args
        .send_modeling_cmd(
            id,
            ModelingCmd::EntityLinearPattern {
                axis: kittycad::types::Point3D {
                    x: data.axis()[0],
                    y: data.axis()[1],
                    z: data.axis()[2],
                },
                entity_id: geometry.id(),
                num_repetitions: data.repetitions(),
                spacing: data.distance(),
            },
        )
        .await?;

    let kittycad::types::OkWebSocketResponseData::Modeling {
        modeling_response: kittycad::types::OkModelingCmdResponse::EntityLinearPattern { data: pattern_info },
    } = &resp
    else {
        return Err(KclError::Engine(KclErrorDetails {
            message: format!("EntityLinearPattern response was not as expected: {:?}", resp),
            source_ranges: vec![args.source_range],
        }));
    };

    let geometries = match geometry {
        Geometry::SketchGroup(sketch_group) => {
            let mut geometries = vec![sketch_group.clone()];
            for id in pattern_info.entity_ids.iter() {
                let mut new_sketch_group = sketch_group.clone();
                new_sketch_group.id = *id;
                geometries.push(new_sketch_group);
            }
            Geometries::SketchGroups(geometries)
        }
        Geometry::ExtrudeGroup(extrude_group) => {
            let mut geometries = vec![extrude_group.clone()];
            for id in pattern_info.entity_ids.iter() {
                let mut new_extrude_group = extrude_group.clone();
                new_extrude_group.id = *id;
                geometries.push(new_extrude_group);
            }
            Geometries::ExtrudeGroups(geometries)
        }
    };

    Ok(geometries)
}

/// Data for a circular pattern on a 2D sketch.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, ts_rs::TS, JsonSchema)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CircularPattern2dData {
    /// The number of repetitions. Must be greater than 0.
    /// This excludes the original entity. For example, if `repetitions` is 1,
    /// the original entity will be copied once.
    pub repetitions: Uint,
    /// The center about which to make the pattern. This is a 2D vector.
    pub center: [f64; 2],
    /// The arc angle (in degrees) to place the repetitions. Must be greater than 0.
    pub arc_degrees: f64,
    /// Whether or not to rotate the duplicates as they are copied.
    pub rotate_duplicates: bool,
}

/// Data for a circular pattern on a 3D model.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, ts_rs::TS, JsonSchema)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CircularPattern3dData {
    /// The number of repetitions. Must be greater than 0.
    /// This excludes the original entity. For example, if `repetitions` is 1,
    /// the original entity will be copied once.
    pub repetitions: Uint,
    /// The axis around which to make the pattern. This is a 3D vector.
    pub axis: [f64; 3],
    /// The center about which to make the pattern. This is a 3D vector.
    pub center: [f64; 3],
    /// The arc angle (in degrees) to place the repetitions. Must be greater than 0.
    pub arc_degrees: f64,
    /// Whether or not to rotate the duplicates as they are copied.
    pub rotate_duplicates: bool,
}

pub enum CircularPattern {
    ThreeD(CircularPattern3dData),
    TwoD(CircularPattern2dData),
}

impl CircularPattern {
    pub fn axis(&self) -> [f64; 3] {
        match self {
            CircularPattern::TwoD(_lp) => [0.0, 0.0, 0.0],
            CircularPattern::ThreeD(lp) => lp.axis,
        }
    }

    pub fn center(&self) -> [f64; 3] {
        match self {
            CircularPattern::TwoD(lp) => [lp.center[0], lp.center[1], 0.0],
            CircularPattern::ThreeD(lp) => lp.center,
        }
    }

    pub fn repetitions(&self) -> u32 {
        match self {
            CircularPattern::TwoD(lp) => lp.repetitions.u32(),
            CircularPattern::ThreeD(lp) => lp.repetitions.u32(),
        }
    }

    pub fn arc_degrees(&self) -> f64 {
        match self {
            CircularPattern::TwoD(lp) => lp.arc_degrees,
            CircularPattern::ThreeD(lp) => lp.arc_degrees,
        }
    }

    pub fn rotate_duplicates(&self) -> bool {
        match self {
            CircularPattern::TwoD(lp) => lp.rotate_duplicates,
            CircularPattern::ThreeD(lp) => lp.rotate_duplicates,
        }
    }
}

/// A circular pattern on a 2D sketch.
pub async fn pattern_circular_2d(args: Args) -> Result<MemoryItem, KclError> {
    let (data, sketch_group_set): (CircularPattern2dData, SketchGroupSet) = args.get_data_and_sketch_group_set()?;

    let sketch_groups = inner_pattern_circular_2d(data, sketch_group_set, args).await?;
    Ok(MemoryItem::SketchGroups { value: sketch_groups })
}

/// A circular pattern on a 2D sketch.
///
/// ```no_run
/// const exampleSketch = startSketchOn('XZ')
///   |> startProfileAt([.5, 25], %)
///   |> line([0, 5], %)
///   |> line([-1, 0], %)
///   |> line([0, -5], %)
///   |> close(%)
///   |> patternCircular2d({
///        center: [0, 0],
///        repetitions: 12,
///        arcDegrees: 360,
///        rotateDuplicates: true
///      }, %)
///
/// const example = extrude(1, exampleSketch)
/// ```
#[stdlib {
    name = "patternCircular2d",
}]
async fn inner_pattern_circular_2d(
    data: CircularPattern2dData,
    sketch_group_set: SketchGroupSet,
    args: Args,
) -> Result<Vec<Box<SketchGroup>>, KclError> {
    let starting_sketch_groups = match sketch_group_set {
        SketchGroupSet::SketchGroup(sketch_group) => vec![sketch_group],
        SketchGroupSet::SketchGroups(sketch_groups) => sketch_groups,
    };

    if args.ctx.is_mock {
        return Ok(starting_sketch_groups);
    }

    let mut sketch_groups = Vec::new();
    for sketch_group in starting_sketch_groups.iter() {
        let geometries = pattern_circular(
            CircularPattern::TwoD(data.clone()),
            Geometry::SketchGroup(sketch_group.clone()),
            args.clone(),
        )
        .await?;

        let Geometries::SketchGroups(new_sketch_groups) = geometries else {
            return Err(KclError::Semantic(KclErrorDetails {
                message: "Expected a vec of sketch groups".to_string(),
                source_ranges: vec![args.source_range],
            }));
        };

        sketch_groups.extend(new_sketch_groups);
    }

    Ok(sketch_groups)
}

/// A circular pattern on a 3D model.
pub async fn pattern_circular_3d(args: Args) -> Result<MemoryItem, KclError> {
    let (data, extrude_group_set): (CircularPattern3dData, ExtrudeGroupSet) = args.get_data_and_extrude_group_set()?;

    let extrude_groups = inner_pattern_circular_3d(data, extrude_group_set, args).await?;
    Ok(MemoryItem::ExtrudeGroups { value: extrude_groups })
}

/// A circular pattern on a 3D model.
///
/// ```no_run
/// const exampleSketch = startSketchOn('XZ')
///   |> circle([0, 0], 1, %)
///
/// const example = extrude(-5, exampleSketch)
///   |> patternCircular3d({
///        axis: [1, -1, 0],
///        center: [10, -20, 0],
///        repetitions: 10,
///        arcDegrees: 360,
///        rotateDuplicates: true
///      }, %)
/// ```
#[stdlib {
    name = "patternCircular3d",
}]
async fn inner_pattern_circular_3d(
    data: CircularPattern3dData,
    extrude_group_set: ExtrudeGroupSet,
    args: Args,
) -> Result<Vec<Box<ExtrudeGroup>>, KclError> {
    let starting_extrude_groups = match extrude_group_set {
        ExtrudeGroupSet::ExtrudeGroup(extrude_group) => vec![extrude_group],
        ExtrudeGroupSet::ExtrudeGroups(extrude_groups) => extrude_groups,
    };

    if args.ctx.is_mock {
        return Ok(starting_extrude_groups);
    }

    let mut extrude_groups = Vec::new();
    for extrude_group in starting_extrude_groups.iter() {
        let geometries = pattern_circular(
            CircularPattern::ThreeD(data.clone()),
            Geometry::ExtrudeGroup(extrude_group.clone()),
            args.clone(),
        )
        .await?;

        let Geometries::ExtrudeGroups(new_extrude_groups) = geometries else {
            return Err(KclError::Semantic(KclErrorDetails {
                message: "Expected a vec of extrude groups".to_string(),
                source_ranges: vec![args.source_range],
            }));
        };

        extrude_groups.extend(new_extrude_groups);
    }

    Ok(extrude_groups)
}

async fn pattern_circular(data: CircularPattern, geometry: Geometry, args: Args) -> Result<Geometries, KclError> {
    let id = uuid::Uuid::new_v4();

    let resp = args
        .send_modeling_cmd(
            id,
            ModelingCmd::EntityCircularPattern {
                axis: kittycad::types::Point3D {
                    x: data.axis()[0],
                    y: data.axis()[1],
                    z: data.axis()[2],
                },
                entity_id: geometry.id(),
                center: data.center().into(),
                num_repetitions: data.repetitions(),
                arc_degrees: data.arc_degrees(),
                rotate_duplicates: data.rotate_duplicates(),
            },
        )
        .await?;

    let kittycad::types::OkWebSocketResponseData::Modeling {
        modeling_response: kittycad::types::OkModelingCmdResponse::EntityCircularPattern { data: pattern_info },
    } = &resp
    else {
        return Err(KclError::Engine(KclErrorDetails {
            message: format!("EntityCircularPattern response was not as expected: {:?}", resp),
            source_ranges: vec![args.source_range],
        }));
    };

    let geometries = match geometry {
        Geometry::SketchGroup(sketch_group) => {
            let mut geometries = vec![sketch_group.clone()];
            for id in pattern_info.entity_ids.iter() {
                let mut new_sketch_group = sketch_group.clone();
                new_sketch_group.id = *id;
                geometries.push(new_sketch_group);
            }
            Geometries::SketchGroups(geometries)
        }
        Geometry::ExtrudeGroup(extrude_group) => {
            let mut geometries = vec![extrude_group.clone()];
            for id in pattern_info.entity_ids.iter() {
                let mut new_extrude_group = extrude_group.clone();
                new_extrude_group.id = *id;
                geometries.push(new_extrude_group);
            }
            Geometries::ExtrudeGroups(geometries)
        }
    };

    Ok(geometries)
}

fn array_to_point3d(json: &serde_json::Value, source_ranges: Vec<SourceRange>) -> Result<Point3d, KclError> {
    let serde_json::Value::Array(arr) = dbg!(json) else {
        return Err(KclError::Semantic(KclErrorDetails {
            message: "Expected an array of 3 numbers (i.e. a 3D point)".to_string(),
            source_ranges,
        }));
    };
    let len = arr.len();
    if len != 3 {
        return Err(KclError::Semantic(KclErrorDetails {
            message: format!("Expected an array of 3 numbers (i.e. a 3D point) but found {len} items"),
            source_ranges,
        }));
    };
    let Some(x) = arr[0].as_number().and_then(|num| num.as_f64()) else {
        return Err(KclError::Semantic(KclErrorDetails {
            message: "X component of this point was not a number".to_owned(),
            source_ranges,
        }));
    };
    let Some(y) = arr[1].as_number().and_then(|num| num.as_f64()) else {
        return Err(KclError::Semantic(KclErrorDetails {
            message: "Y component of this point was not a number".to_owned(),
            source_ranges,
        }));
    };
    let Some(z) = arr[2].as_number().and_then(|num| num.as_f64()) else {
        return Err(KclError::Semantic(KclErrorDetails {
            message: "Z component of this point was not a number".to_owned(),
            source_ranges,
        }));
    };
    Ok(Point3d {
        x: x.to_owned().into(),
        y: y.to_owned(),
        z: z.to_owned(),
    })
}
