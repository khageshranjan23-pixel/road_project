"""
road_analyzer.py
================
Analyses per-frame vehicle data to:
  1. Compute safe crossing time windows
  2. Simulate a user-chosen crossing scenario
"""

import numpy as np
from typing import Any


# ── Constants ─────────────────────────────────────────────────────────────────
DEFAULT_PED_SPEED = 1.4      # m/s (normal walk)
SAFETY_BUFFER     = 2.0      # extra seconds of safety margin
MIN_GAP           = 1.5      # minimum gap (seconds) between car arrivals to cross


def compute_crossing_windows(
    frame_results: list[dict],
    road_width_m: float,
    ped_speed: float = DEFAULT_PED_SPEED,
    safety_buffer: float = SAFETY_BUFFER,
    fps: float = 30.0,
) -> list[dict]:
    """
    For every second of video, decide if it is a safe crossing window.
    Uses the lane-aware physical crossing simulator for each second.
    """
    if not frame_results:
        return []

    # Get max time in seconds
    max_time = int(max([fr["time_s"] for fr in frame_results]))
    windows = []

    # Extract frame_width from the frame_results if possible
    frame_width = 1920
    for fr in frame_results:
        for v in fr["vehicles"]:
            if "bbox" in v and len(v["bbox"]) >= 3:
                frame_width = max(frame_width, v["bbox"][2])

    for second in range(max_time + 1):
        sim_res = simulate_crossing(
            frame_results=frame_results,
            start_time=float(second),
            ped_speed=ped_speed,
            road_width_m=road_width_m,
            frame_width=frame_width,
            safety_buffer=safety_buffer,
            fps=fps
        )
        
        safe = sim_res["safe"]
        sim_vehs = sim_res["simulated_vehicles"]
        min_tta = None
        if sim_vehs:
            ttas = [v["t_arrival"] for v in sim_vehs if v["t_arrival"] > 0]
            if ttas:
                min_tta = min(ttas)

        gap = min_tta

        # For recommended speed, find a speed that works if default doesn't
        rec_speed = ped_speed
        if not safe:
            for s_test in [2.0, 2.8, 3.6, 4.0]:
                test_res = simulate_crossing(
                    frame_results=frame_results,
                    start_time=float(second),
                    ped_speed=s_test,
                    road_width_m=road_width_m,
                    frame_width=frame_width,
                    safety_buffer=safety_buffer,
                    fps=fps
                )
                if test_res["safe"]:
                    rec_speed = s_test
                    break

        windows.append({
            "second":            second,
            "safe":              safe,
            "min_tta":           round(min_tta, 2) if min_tta is not None else None,
            "gap":               round(gap, 2) if gap is not None else None,
            "recommended_speed": round(rec_speed, 2),
            "reason":            sim_res["result"],
        })

    return windows


def simulate_crossing(
    frame_results: list[dict],
    start_time: float,
    ped_speed: float,
    road_width_m: float,
    frame_width: int = 1920,
    safety_buffer: float = SAFETY_BUFFER,
    fps: float = 30.0,
) -> dict:
    """
    Advanced lane-aware physical crossing simulation.
    Simulates pedestrian walking across N lanes, and tracks the trajectory
    of all active vehicles to detect lane-specific collisions.
    """
    num_lanes = 3
    lane_width = road_width_m / num_lanes
    cross_time = road_width_m / ped_speed
    end_time = start_time + cross_time

    # Find active vehicles at start_time: scan ±1.5s window
    active_vehicles_map = {}
    
    for fr in frame_results:
        t_frame = fr["time_s"]
        if abs(t_frame - start_time) <= 1.5:
            for v in fr["vehicles"]:
                v_id = v["id"]
                dist = v.get("dist_m")
                vel = v.get("velocity_kmh")
                centroid = v.get("centroid")
                
                if dist is not None and vel is not None and centroid is not None:
                    dev = abs(t_frame - start_time)
                    if v_id not in active_vehicles_map or dev < active_vehicles_map[v_id]["dev"]:
                        active_vehicles_map[v_id] = {
                            "id": v_id,
                            "class": v["class"],
                            "dist_m": dist,
                            "velocity_kmh": vel,
                            "cx": centroid[0],
                            "cy": centroid[1],
                            "dev": dev,
                            "time_s": t_frame,
                        }

    # Simulate movements
    simulated_vehicles = []
    collisions = []
    
    # Time steps for simulation
    dt = 0.05
    t_steps = np.arange(0, cross_time + 2.0, dt)

    for v_id, v_info in active_vehicles_map.items():
        v_class = v_info["class"]
        init_dist = v_info["dist_m"]
        vel_kmh = v_info["velocity_kmh"]
        vel_ms = vel_kmh / 3.6
        cx = v_info["cx"]

        # If vehicle is moving away or already passed, ignore it
        if vel_ms <= 0.1 or init_dist <= 0:
            continue

        # Determine lane based on horizontal position (cx)
        lane = 1 + int((cx / max(frame_width, 1)) * num_lanes)
        lane = max(1, min(num_lanes, lane))

        # Time when this vehicle crosses the line
        t_arrival_from_start = init_dist / vel_ms
        time_diff = start_time - v_info["time_s"]
        t_arrival = t_arrival_from_start - time_diff

        # Vehicle occupies crossing zone for a time window
        veh_len = 5.0 if v_class in ["car", "truck", "bus"] else 2.0
        occupy_duration = (veh_len / vel_ms) + 0.5
        t_enter = t_arrival - 0.2
        t_exit = t_arrival + occupy_duration

        # Build trajectory
        trajectory = []
        for t in t_steps:
            current_dist = init_dist - vel_ms * (t + time_diff)
            trajectory.append({
                "time": round(float(t), 2),
                "dist_m": round(float(current_dist), 2),
            })

        sim_veh = {
            "id": v_id,
            "class": v_class,
            "lane": lane,
            "velocity_kmh": round(vel_kmh, 1),
            "init_dist_m": round(init_dist, 2),
            "t_arrival": round(t_arrival, 2),
            "t_enter": round(t_enter, 2),
            "t_exit": round(t_exit, 2),
            "trajectory": trajectory,
            "collision": False,
        }

        # Check for collision
        ped_enter_lane_t = (lane - 1) * lane_width / ped_speed
        ped_exit_lane_t = lane * lane_width / ped_speed

        overlap_start = max(ped_enter_lane_t, t_enter)
        overlap_end = min(ped_exit_lane_t, t_exit)

        if overlap_start < overlap_end:
            sim_veh["collision"] = True
            collisions.append({
                "time": round(float(overlap_start), 2),
                "lane": lane,
                "vehicle": sim_veh,
            })

        simulated_vehicles.append(sim_veh)

    # Sort simulated vehicles by arrival time
    simulated_vehicles.sort(key=lambda x: x["t_arrival"])

    # Determine safe status
    safe = len(collisions) == 0

    if safe:
        if simulated_vehicles:
            # Safety margins of all vehicles
            margins = [v["t_arrival"] - cross_time for v in simulated_vehicles if v["t_arrival"] > 0]
            min_margin = min(margins) if margins else 99.0
            
            if min_margin >= safety_buffer:
                result = f"SAFE — Clear crossing with {min_margin:.1f}s safety margin"
                recommendation = "Optimal crossing window. Proceed at normal speed."
            else:
                result = f"RISKY — Tight fit. Only {min_margin:.1f}s margin (safety buffer is {safety_buffer}s)"
                recommendation = "You can cross, but you should walk fast!"
        else:
            result = "SAFE — No vehicles detected in vicinity"
            recommendation = "Road is completely clear. Go ahead and cross!"
    else:
        collisions.sort(key=lambda x: x["time"])
        first_collision = collisions[0]
        col_veh = first_collision["vehicle"]
        result = f"COLLISION DANGER — Hit by #{col_veh['id']} {col_veh['class']} in Lane {first_collision['lane']} at {first_collision['time']:.1f}s"
        
        # Calculate speed required to avoid it
        needed_speed = (first_collision["lane"] * lane_width) / max(col_veh["t_enter"], 0.1)
        if needed_speed <= 4.0:
            recommendation = f"Danger! Walk faster at {needed_speed:.1f} m/s ({needed_speed*3.6:.1f} km/h) to clear Lane {first_collision['lane']} before the vehicle arrives."
        else:
            recommendation = "DO NOT CROSS. Vehicle arriving too fast. Wait for a safer gap."

    return {
        "start_time": start_time,
        "ped_speed": ped_speed,
        "cross_time": round(cross_time, 2),
        "end_time": round(end_time, 2),
        "safe": safe,
        "result": result,
        "recommendation": recommendation,
        "num_lanes": num_lanes,
        "lane_width": round(lane_width, 2),
        "road_width_m": round(road_width_m, 2),
        "simulated_vehicles": simulated_vehicles,
        "collisions": collisions,
    }
